import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { getGlobalState } from './global-state.js';
import type { DispatchTask, AttentionLayer } from './types.js';
import { isMetaSubagentChat } from './flags.js';

export interface DispatchArgs {
  contentDirection: string;
  toneGuidance?: string;
  quotes?: Array<number | string>;
  /** Burst siblings (excl. primary quote); answered only after successful send. */
  relatedQuotes?: Array<number | string>;
  trackingKey?: string;
  /** Person being replied to (persona/{uid}.md). Usually Attention.userId. */
  targetUserId?: number;
  /**
   * Allow dispatch for L2 passive attention. Default false — Meta must not
   * jump into every group message (replaces Heart's silence bias).
   */
  interrupt?: boolean;
}

export function buildMetaApiContext(opts?: {
  dispatchedChatIds?: Set<number>;
  isAborted?: () => boolean;
  /** Highest-priority attention layer per chat in this session. */
  chatLayer?: Map<number, AttentionLayer>;
  /** Default reply-to messageId per chat (from Attention). */
  defaultQuotes?: Map<number, number>;
  /** Default target userId per chat (from Attention). */
  defaultTargetUserIds?: Map<number, number>;
}): Record<string, unknown> {
  const state = getGlobalState();

  const dispatch = {
    async taskToGroup(chatId: number | string, args: DispatchArgs): Promise<{ taskId: string }> {
      if (opts?.isAborted?.()) throw new Error('meta_aborted');
      const cid = Number(chatId);
      if (!Number.isFinite(cid) || cid === 0) throw new Error('invalid chatId');
      if (!isMetaSubagentChat(cid)) throw new Error(`chat ${cid} not on Meta+Subagent path`);
      if (!args?.contentDirection?.trim()) throw new Error('contentDirection required');

      const layer = opts?.chatLayer?.get(cid) ?? 'L2';
      if (layer === 'L2' && !args.interrupt) {
        logger.info({ chatId: cid, layer }, 'Meta dispatch blocked (L2 needs interrupt:true)');
        return { taskId: 'blocked_l2' };
      }

      // Claim this chat immediately (sync) so parallel fire-and-forget
      // dispatch.taskToGroup(...) can't enqueue two CodeActs in one session.
      if (opts?.dispatchedChatIds) {
        if (opts.dispatchedChatIds.has(cid)) {
          logger.info({ chatId: cid }, 'Meta dispatch skipped (already dispatched this session)');
          return { taskId: 'skipped_dup' };
        }
        opts.dispatchedChatIds.add(cid);
      }

      const unclaim = () => {
        opts?.dispatchedChatIds?.delete(cid);
      };

      // One in-flight CodeAct per chat — Redis lock + in-memory (cross-tick / restart safe).
      let busy = false;
      try {
        const { isCodeActBusy } = await import('../subagent/task-store.js');
        busy = await isCodeActBusy(cid);
      } catch {
        busy = false;
      }
      if (!busy) {
        busy = state.listTasks(cid).some(
          (t) =>
            (t.status === 'queued' || t.status === 'running') &&
            Date.now() - t.createdAt < 180_000,
        );
      }
      if (busy) {
        unclaim();
        logger.info({ chatId: cid }, 'Meta dispatch skipped (chat busy)');
        return { taskId: 'skipped_busy' };
      }

      // Meta LLM JS used to bypass autoDispatch's Heart refractory → near-dup
      // second bubbles. L0/@ still dispatches; L1 Heart gap-fill must not.
      if (layer !== 'L0') {
        try {
          const { shouldSuppressMetaHeartDispatch } = await import('./heart-refractory.js');
          if (await shouldSuppressMetaHeartDispatch(cid)) {
            unclaim();
            logger.info({ chatId: cid, layer }, 'Meta dispatch skipped (heart refractory)');
            return { taskId: 'skipped_refractory' };
          }
        } catch {
          /* fail-open */
        }
      }

      let quotes = (args.quotes ?? [])
        .map((q) => (typeof q === 'string' ? Number(q.replace(/^msg:/, '')) : Number(q)))
        .filter((n) => Number.isFinite(n) && n > 0);
      // Model may target a specific msg; only fill when omitted.
      const fallbackQuote = opts?.defaultQuotes?.get(cid);
      if (!quotes.length && fallbackQuote) quotes = [fallbackQuote];
      if (!quotes.length) {
        const m = args.contentDirection.match(/#(\d{1,12})/);
        if (m?.[1]) quotes = [Number(m[1])];
      }

      try {
        const { allQuotesAnswered } = await import('./answered.js');
        if (await allQuotesAnswered(cid, quotes)) {
          // Already answered — unclaim so gap-fill can still dispatch a
          // *different* (unanswered) L0 in the same chat this session.
          unclaim();
          logger.info({ chatId: cid, quotes }, 'Meta dispatch skipped (already answered quotes)');
          return { taskId: 'skipped_answered' };
        }
      } catch {
        /* fail-open */
      }

      const quoteId = quotes[0];
      const { sanitizeContentDirection } = await import('../shared/message-text.js');
      const relatedQuoteIds = (args.relatedQuotes ?? [])
        .map((q) => (typeof q === 'string' ? Number(q.replace(/^msg:/, '')) : Number(q)))
        .filter((n) => Number.isFinite(n) && n > 0 && !quotes.includes(n));

      const task: DispatchTask = {
        id: randomUUID(),
        chatId: cid,
        contentDirection: sanitizeContentDirection(
          args.contentDirection.trim().slice(0, 2000),
          quoteId,
        ),
        toneGuidance: args.toneGuidance?.slice(0, 500),
        quoteMessageIds: quotes,
        relatedQuoteIds: relatedQuoteIds.length ? relatedQuoteIds : undefined,
        targetUserId:
          (typeof args.targetUserId === 'number' && args.targetUserId > 0
            ? args.targetUserId
            : undefined) ?? opts?.defaultTargetUserIds?.get(cid),
        trackingKey: args.trackingKey,
        createdAt: Date.now(),
        status: 'queued',
      };

      // Atomic quote + chat locks BEFORE enqueue (kills same-ms double dispatch).
      try {
        const { tryClaimQuote, tryMarkCodeActActive } = await import('../subagent/task-store.js');
        const quoteId = quotes[0] ?? 0;
        if (quoteId > 0 && !(await tryClaimQuote(cid, quoteId, task.id))) {
          unclaim();
          logger.info({ chatId: cid, quotes }, 'Meta dispatch skipped (quote already claimed)');
          return { taskId: 'skipped_dup' };
        }
        if (!(await tryMarkCodeActActive(cid, task.id))) {
          unclaim();
          logger.info({ chatId: cid }, 'Meta dispatch skipped (chat active lock)');
          return { taskId: 'skipped_busy' };
        }
      } catch (err) {
        logger.warn({ err, chatId: cid }, 'Meta dispatch lock failed — continuing');
      }

      state.putTask(task);
      logger.info(
        { taskId: task.id, chatId: cid, layer, quotes, interrupt: !!args.interrupt },
        'Meta dispatch.taskToGroup',
      );
      try {
        const { enqueueCodeActJob } = await import('../subagent/queue.js');
        await enqueueCodeActJob(task);
      } catch (err) {
        logger.warn({ err, taskId: task.id }, 'Meta dispatch enqueue failed — local fallback');
        try {
          const { enqueueSubagentTaskLocal } = await import('../subagent/executor.js');
          enqueueSubagentTaskLocal(task);
        } catch (err2) {
          const { clearCodeActActive } = await import('../subagent/task-store.js');
          await clearCodeActActive(cid, task.id);
          unclaim();
          logger.warn({ err: err2, taskId: task.id }, 'Meta dispatch local enqueue failed');
          return { taskId: 'enqueue_failed' };
        }
      }
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

  const journal = {
    /** Decide+append diary via dream-journal module (model WRITE/SKIP). */
    async tryWrite(args?: {
      slot?: string;
      /** User-initiated write: bypass Meta cooldown. */
      force?: boolean;
    }): Promise<{
      wrote: boolean;
      path: string | null;
      slot: string;
      reason?: string;
      snippet?: string | null;
    }> {
      if (opts?.isAborted?.()) throw new Error('meta_aborted');
      const { tryWriteDreamJournal, readRecentDreamSnippet } = await import('../cron/dream-journal.js');
      const result = await tryWriteDreamJournal({
        slot: args?.slot,
        force: !!args?.force,
      });
      let snippet: string | null = null;
      if (result.wrote) {
        snippet = await readRecentDreamSnippet(280);
      }
      logger.info({ ...result, forced: !!args?.force }, 'Meta journal.tryWrite');
      return { ...result, snippet };
    },
    async recent(maxChars?: number): Promise<{ snippet: string | null }> {
      const { readRecentDreamSnippet } = await import('../cron/dream-journal.js');
      return { snippet: await readRecentDreamSnippet(maxChars ?? 400) };
    },
  };

  return {
    dispatch: Object.freeze(dispatch),
    todo: Object.freeze(todo),
    agents: Object.freeze(agents),
    conversations: Object.freeze(conversations),
    memory: Object.freeze(memory),
    journal: Object.freeze(journal),
  };
}
