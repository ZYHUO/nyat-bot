import type { DispatchTask, MetaSessionDigest, SubagentCallback } from './types.js';
import { logger } from '../shared/logger.js';

const MAX_DIGESTS = 40;
const MAX_TASKS = 200;
const MAX_CALLBACKS = 100;
const CALLBACK_KEY = 'xxb:meta:callbacks';

/** Atomic claim callbacks — LRANGE + DEL in one Lua script. */
const CLAIM_CALLBACKS_LUA = `
local key = KEYS[1]
local items = redis.call('LRANGE', key, 0, -1)
redis.call('DEL', key)
return items
`;

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
    void this.enqueueCallbackAsync(cb);
  }

  async enqueueCallbackAsync(cb: SubagentCallback): Promise<void> {
    try {
      await this.mirrorCallback(cb);
    } catch {
      this.pendingCallbacks.push(cb);
      if (this.pendingCallbacks.length > MAX_CALLBACKS) {
        this.pendingCallbacks.splice(0, this.pendingCallbacks.length - MAX_CALLBACKS);
      }
    }
  }

  private async mirrorCallback(cb: SubagentCallback): Promise<void> {
    const { getRedis } = await import('../db/redis.js');
    const redis = getRedis();
    await redis
      .multi()
      .lpush(CALLBACK_KEY, JSON.stringify(cb))
      .ltrim(CALLBACK_KEY, 0, MAX_CALLBACKS - 1)
      .exec();
  }

  async drainCallbacks(): Promise<SubagentCallback[]> {
    const byId = new Map<string, SubagentCallback>();
    const local = this.pendingCallbacks.splice(0, this.pendingCallbacks.length);
    for (const cb of local) byId.set(cb.id, cb);

    try {
      const { getRedis } = await import('../db/redis.js');
      const redis = getRedis();
      const raw = (await redis.eval(CLAIM_CALLBACKS_LUA, 1, CALLBACK_KEY)) as string[];
      for (const r of raw ?? []) {
        try {
          const cb = JSON.parse(r) as SubagentCallback;
          if (cb?.id) byId.set(cb.id, cb);
        } catch {
          /* drop */
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Callback atomic drain failed — local only');
    }
    return Array.from(byId.values());
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
