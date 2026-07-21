import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { getGlobalState } from './global-state.js';
import type { DispatchTask } from './types.js';
import { enqueueSubagentTask } from '../subagent/executor.js';
import { isMetaSubagentChat } from './flags.js';

export interface DispatchArgs {
  contentDirection: string;
  toneGuidance?: string;
  quotes?: Array<number | string>;
  trackingKey?: string;
}

/**
 * Meta sandbox APIs — orchestration only. Sending chat messages happens in Subagent.
 * @param opts.dispatchedChatIds — filled as taskToGroup runs (for L0 gap-fill / timeout dedupe)
 * @param opts.isAborted — after Meta Promise.race settles, block zombie dispatches
 */
export function buildMetaApiContext(opts?: {
  dispatchedChatIds?: Set<number>;
  isAborted?: () => boolean;
}): Record<string, unknown> {
  const state = getGlobalState();

  const dispatch = {
    async taskToGroup(chatId: number | string, args: DispatchArgs): Promise<{ taskId: string }> {
      if (opts?.isAborted?.()) throw new Error('meta_aborted');
      const cid = Number(chatId);
      if (!Number.isFinite(cid) || cid === 0) throw new Error('invalid chatId');
      if (!isMetaSubagentChat(cid)) throw new Error(`chat ${cid} not on Meta+Subagent path`);
      if (!args?.contentDirection?.trim()) throw new Error('contentDirection required');

      const quotes = (args.quotes ?? [])
        .map((q) => (typeof q === 'string' ? Number(q.replace(/^msg:/, '')) : Number(q)))
        .filter((n) => Number.isFinite(n) && n > 0);

      const task: DispatchTask = {
        id: randomUUID(),
        chatId: cid,
        contentDirection: args.contentDirection.trim().slice(0, 2000),
        toneGuidance: args.toneGuidance?.slice(0, 500),
        quoteMessageIds: quotes,
        trackingKey: args.trackingKey,
        createdAt: Date.now(),
        status: 'queued',
      };
      state.putTask(task);
      opts?.dispatchedChatIds?.add(cid);
      logger.info({ taskId: task.id, chatId: cid }, 'Meta dispatch.taskToGroup');
      void enqueueSubagentTask(task);
      return { taskId: task.id };
    },
    getTask(taskId: string) {
      return state.getTask(String(taskId)) ?? null;
    },
    listTasks(chatId?: number | string) {
      return state.listTasks(chatId === undefined ? undefined : Number(chatId));
    },
  };

  const todo = {
    add(text: string) {
      const id = randomUUID();
      state.todos.push({ id, text: String(text).slice(0, 500), createdAt: Date.now() });
      return { id };
    },
    list() {
      return [...state.todos];
    },
    remove(id: string) {
      state.todos = state.todos.filter((t) => t.id !== id);
      return true;
    },
  };

  const agents = {
    listStatus() {
      return state.listTasks().slice(-20).map((t) => ({
        taskId: t.id,
        chatId: t.chatId,
        status: t.status,
        direction: t.contentDirection.slice(0, 80),
      }));
    },
  };

  const conversations = {
    query(hint: string) {
      return { hint: String(hint).slice(0, 200), note: 'use dispatch; Subagent reads chat context' };
    },
  };

  const memory = {
    searchEntities(query: string) {
      return { query: String(query).slice(0, 200), note: 'entity search runs in Subagent host.memory' };
    },
  };

  return {
    dispatch: Object.freeze(dispatch),
    todo: Object.freeze(todo),
    agents: Object.freeze(agents),
    conversations: Object.freeze(conversations),
    memory: Object.freeze(memory),
  };
}
