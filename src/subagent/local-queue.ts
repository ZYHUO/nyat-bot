import type { DispatchTask } from '../meta/types.js';

interface LocalQueueDependencies {
  concurrency(): number;
  claim(task: DispatchTask): Promise<boolean>;
  run(task: DispatchTask): Promise<void>;
  release(task: DispatchTask): Promise<void>;
  failed(task: DispatchTask, error: unknown): void;
}

/** The fallback has no durable queue receipt: pending work forbids a clean exit. */
export class LocalCodeActQueue {
  private readonly byChat = new Map<number, DispatchTask[]>();
  private readonly runningChats = new Set<number>();
  private readonly active = new Set<Promise<void>>();
  private readonly retryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private stopping = false;
  private unsettledFailure = false;

  constructor(private readonly deps: LocalQueueDependencies) {}

  enqueue(task: DispatchTask): void {
    if (this.stopping) throw new Error('codeact_draining');
    this.requeue(task);
    this.pump();
  }

  private requeue(task: DispatchTask): void {
    const queue = this.byChat.get(task.chatId) ?? [];
    queue.push(task);
    this.byChat.set(task.chatId, queue);
  }

  private retryClaimLater(chatId: number): void {
    if (this.stopping || this.retryTimers.has(chatId)) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(chatId);
      this.pump();
    }, 2_500);
    timer.unref();
    this.retryTimers.set(chatId, timer);
  }

  private pump(): void {
    if (this.stopping) return;
    for (const [chatId, queue] of this.byChat) {
      if (this.active.size >= this.deps.concurrency()) break;
      if (this.runningChats.has(chatId) || this.retryTimers.has(chatId) || !queue.length) continue;
      const task = queue.shift()!;
      if (!queue.length) this.byChat.delete(chatId);
      this.runningChats.add(chatId);
      const pending = Promise.resolve().then(async () => {
        const claimed = await this.deps.claim(task);
        if (!claimed) {
          this.requeue(task);
          this.retryClaimLater(chatId);
          return;
        }
        try {
          // A claim that resolves after shutdown must not start a new send.
          if (this.stopping) this.requeue(task);
          else await this.deps.run(task);
        } finally { await this.deps.release(task); }
      }).catch(error => {
        // No durable queue owns this task. A failed claim or execution cannot
        // disappear into a log and then authorize a clean release handoff.
        // Never retry an execution with an unknown send outcome here.
        this.unsettledFailure = true;
        this.deps.failed(task, error);
      }).finally(() => {
        this.runningChats.delete(chatId);
        this.active.delete(pending);
        this.pump();
      });
      this.active.add(pending);
    }
  }

  stop(): void {
    this.stopping = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  async drain(): Promise<void> {
    this.stop();
    while (this.active.size) await Promise.all([...this.active]);
    if (this.unsettledFailure) throw new Error('codeact_local_failed_without_queue_receipt');
    if (this.byChat.size) throw new Error('codeact_local_pending_without_queue_receipt');
  }

  resetForTest(): void {
    this.stop();
    this.byChat.clear();
    this.runningChats.clear();
    this.active.clear();
    this.stopping = false;
    this.unsettledFailure = false;
  }
}
