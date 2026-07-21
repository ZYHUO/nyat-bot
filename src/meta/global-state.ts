import type { DispatchTask, MetaSessionDigest, SubagentCallback } from './types.js';

const MAX_DIGESTS = 40;
const MAX_TASKS = 200;
const MAX_CALLBACKS = 100;

export class GlobalState {
  digests: MetaSessionDigest[] = [];
  tasks = new Map<string, DispatchTask>();
  pendingCallbacks: SubagentCallback[] = [];
  todos: Array<{ id: string; text: string; createdAt: number }> = [];

  addDigest(text: string): void {
    this.digests.push({ at: Date.now(), text: text.slice(0, 2000) });
    if (this.digests.length > MAX_DIGESTS) this.digests.splice(0, this.digests.length - MAX_DIGESTS);
  }

  recentDigests(n = 8): MetaSessionDigest[] {
    return this.digests.slice(-n);
  }

  putTask(task: DispatchTask): void {
    this.tasks.set(task.id, task);
    if (this.tasks.size > MAX_TASKS) {
      const oldest = Array.from(this.tasks.values()).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.tasks.delete(oldest.id);
    }
  }

  getTask(id: string): DispatchTask | undefined {
    return this.tasks.get(id);
  }

  listTasks(chatId?: number): DispatchTask[] {
    const all = Array.from(this.tasks.values());
    return chatId === undefined ? all : all.filter((t) => t.chatId === chatId);
  }

  enqueueCallback(cb: SubagentCallback): void {
    this.pendingCallbacks.push(cb);
    if (this.pendingCallbacks.length > MAX_CALLBACKS) {
      this.pendingCallbacks.splice(0, this.pendingCallbacks.length - MAX_CALLBACKS);
    }
  }

  drainCallbacks(): SubagentCallback[] {
    const out = this.pendingCallbacks;
    this.pendingCallbacks = [];
    return out;
  }
}

let _state: GlobalState | null = null;

export function getGlobalState(): GlobalState {
  if (!_state) _state = new GlobalState();
  return _state;
}

export function _resetGlobalState(): void {
  _state = null;
}
