import { randomUUID } from "node:crypto";
import { logger } from "../shared/logger.js";
import { getGlobalState } from "./global-state.js";
import type { DispatchTask, AttentionLayer } from "./types.js";
import { isMetaSubagentChat } from "./flags.js";
import { dispatchCodeActTaskViaAgency } from "../agent/agency-codeact-dispatch.js";
import { recordMetaDispatchObservation } from "../agent/agency-meta-observation.js";
import { recordMetaActionObservation } from "../agent/agency-meta-actions.js";

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
  /** Telegram forum topic (supergroup thread) id; routes reply into the correct topic. */
  messageThreadId?: number;
  /** Durable Telegram event used to anchor this task's workspace. */
  cognitiveAnchorEventId?: string;
  /**
   * 跳过 dispatch 期 timing gate。autoDispatchL0 已自带 gate（非 L0 时）所以
   * 必须传 true 防双重裁决；工作型 dispatch（日记 ack 等 direct 回应）也可传。
   * Meta LLM 主动 gap-fill 的闲聊 dispatch 不传 —— 那正是 gate 要管的。
   */
  skipDispatchGate?: boolean;
}

export function buildMetaApiContext(opts?: {
  defaultChatId?: number;
  dispatchedChatIds?: Set<number>;
  isAborted?: () => boolean;
  /** Highest-priority attention layer per chat in this session. */
  chatLayer?: Map<number, AttentionLayer>;
  /** Default reply-to messageId per chat (from Attention). */
  defaultQuotes?: Map<number, number>;
  /** Default target userId per chat (from Attention). */
  defaultTargetUserIds?: Map<number, number>;
  /** Default durable message event per chat (from Attention). */
  defaultCognitiveAnchorEventIds?: Map<number, string>;
}): Record<string, unknown> {
  const state = getGlobalState();
  const inferredChatId =
    opts?.defaultChatId ??
    opts?.chatLayer?.keys().next().value ??
    opts?.defaultCognitiveAnchorEventIds?.keys().next().value;
  const observeMetaAction = (
    action: Parameters<typeof recordMetaActionObservation>[0]["action"],
    outcome: "completed" | "failed" | "skipped" = "completed",
    reason?: string,
    metadata?: Record<string, string | number | boolean | null>,
  ): void => {
    if (
      typeof inferredChatId !== "number" ||
      !Number.isSafeInteger(inferredChatId) ||
      inferredChatId === 0
    )
      return;
    void recordMetaActionObservation({
      action,
      chatId: inferredChatId,
      anchorEventId: opts?.defaultCognitiveAnchorEventIds?.get(inferredChatId),
      triggerEventId:
        opts?.defaultQuotes?.get(inferredChatId) !== undefined
          ? `telegram:${inferredChatId}:message:${opts.defaultQuotes.get(inferredChatId)}`
          : undefined,
      outcome,
      ...(reason ? { reason } : {}),
      ...(metadata ? { metadata } : {}),
    }).catch(() => {});
  };

  const dispatch = {
    async taskToGroup(
      chatId: number | string,
      args: DispatchArgs,
    ): Promise<{ taskId: string }> {
      if (opts?.isAborted?.()) throw new Error("meta_aborted");
      const cid = Number(chatId);
      if (!Number.isFinite(cid) || cid === 0) throw new Error("invalid chatId");
      if (!isMetaSubagentChat(cid))
        throw new Error(`chat ${cid} not on Meta+Subagent path`);
      if (!args?.contentDirection?.trim())
        throw new Error("contentDirection required");

      const layer = opts?.chatLayer?.get(cid) ?? "L2";
      const observationQuotes = (args.quotes ?? [])
        .map((q) =>
          typeof q === "string" ? Number(q.replace(/^msg:/, "")) : Number(q),
        )
        .filter((n) => Number.isSafeInteger(n) && n > 0);
      const defaultObservationQuote = opts?.defaultQuotes?.get(cid);
      if (!observationQuotes.length && defaultObservationQuote !== undefined) {
        observationQuotes.push(defaultObservationQuote);
      }
      const observationAnchor =
        args.cognitiveAnchorEventId ??
        opts?.defaultCognitiveAnchorEventIds?.get(cid);
      const observeDecision = (
        decision: "proposed" | "blocked" | "skipped",
        reason?: string,
        quoteMessageIds: readonly number[] = observationQuotes,
        taskId?: string,
      ): void => {
        void recordMetaDispatchObservation({
          chatId: cid,
          layer,
          quoteMessageIds,
          targetUserId: args.targetUserId,
          interrupt: args.interrupt,
          cognitiveAnchorEventId: observationAnchor,
          taskId,
          decision,
          decisionReason: reason,
        }).catch((err: unknown) => {
          logger.debug(
            { err, chatId: cid, layer, decision, reason },
            "Meta decision observation failed (non-critical)",
          );
        });
      };
      if (layer === "L2" && !args.interrupt) {
        observeDecision("blocked", "l2_interrupt_required");
        logger.info(
          { chatId: cid, layer },
          "Meta dispatch blocked (L2 needs interrupt:true)",
        );
        return { taskId: "blocked_l2" };
      }

      // Claim this chat immediately (sync) so parallel fire-and-forget
      // dispatch.taskToGroup(...) can't enqueue two CodeActs in one session.
      if (opts?.dispatchedChatIds) {
        if (opts.dispatchedChatIds.has(cid)) {
          observeDecision("skipped", "session_duplicate");
          logger.info(
            { chatId: cid },
            "Meta dispatch skipped (already dispatched this session)",
          );
          return { taskId: "skipped_dup" };
        }
        opts.dispatchedChatIds.add(cid);
      }

      const unclaim = () => {
        opts?.dispatchedChatIds?.delete(cid);
      };

      // One in-flight CodeAct per chat — Redis lock + in-memory (cross-tick / restart safe).
      let busy = false;
      try {
        const { isCodeActBusy } = await import("../subagent/task-store.js");
        busy = await isCodeActBusy(cid);
      } catch {
        busy = false;
      }
      if (!busy) {
        busy = state
          .listTasks(cid)
          .some(
            (t) =>
              (t.status === "queued" ||
                t.status === "running" ||
                t.status === "waiting_user") &&
              Date.now() - t.createdAt < 180_000,
          );
      }
      if (busy) {
        unclaim();
        observeDecision("skipped", "codeact_busy");
        logger.info({ chatId: cid }, "Meta dispatch skipped (chat busy)");
        return { taskId: "skipped_busy" };
      }

      // Meta LLM JS used to bypass autoDispatch's Heart refractory → near-dup
      // second bubbles. L0/@ still dispatches; L1 Heart gap-fill must not.
      if (layer !== "L0") {
        try {
          const { shouldSuppressMetaHeartDispatch } =
            await import("./heart-refractory.js");
          if (await shouldSuppressMetaHeartDispatch(cid)) {
            unclaim();
            observeDecision("skipped", "heart_refractory");
            logger.info(
              { chatId: cid, layer },
              "Meta dispatch skipped (heart refractory)",
            );
            return { taskId: "skipped_refractory" };
          }
        } catch {
          /* fail-open */
        }
      }

      let quotes = (args.quotes ?? [])
        .map((q) =>
          typeof q === "string" ? Number(q.replace(/^msg:/, "")) : Number(q),
        )
        .filter((n) => Number.isFinite(n) && n > 0);
      // Model may target a specific msg; only fill when omitted.
      const fallbackQuote = opts?.defaultQuotes?.get(cid);
      if (!quotes.length && fallbackQuote) quotes = [fallbackQuote];
      if (!quotes.length) {
        const m = args.contentDirection.match(/#(\d{1,12})/);
        if (m?.[1]) quotes = [Number(m[1])];
      }

      try {
        const { allQuotesAnswered } = await import("./answered.js");
        if (await allQuotesAnswered(cid, quotes)) {
          // Already answered — unclaim so gap-fill can still dispatch a
          // *different* (unanswered) L0 in the same chat this session.
          unclaim();
          observeDecision("skipped", "already_answered", quotes);
          logger.info(
            { chatId: cid, quotes },
            "Meta dispatch skipped (already answered quotes)",
          );
          return { taskId: "skipped_answered" };
        }
      } catch {
        /* fail-open */
      }

      // Dispatch 期 timing gate：Heart/Meta 决定「说不说」，gate 决定「什么时候说」。
      // L0 direct / L1_CALLBACK 在 helper 内 bypass；autoDispatch 传 skipDispatchGate
      // 因为上面已经带过完整上下文跑过一次。gate 决策 wait/defer/no_action →
      // suppress（wait-resume / defer ZSET 负责到点重评，不丢消息）。
      if (layer !== "L0" && !args.skipDispatchGate) {
        try {
          const { evaluateDispatchGate } = await import("./dispatch-gate.js");
          const gate = await evaluateDispatchGate({
            chatId: cid,
            layer,
            reason: "meta_llm_dispatch",
            messageId: quotes[0],
            userId: args.targetUserId,
            textPreview: args.contentDirection.slice(0, 200),
            messageThreadId: args.messageThreadId,
            cognitiveAnchorEventId:
              args.cognitiveAnchorEventId ??
              opts?.defaultCognitiveAnchorEventIds?.get(cid),
            deferCount: 0,
          });
          if (gate.verdict === "suppress") {
            unclaim();
            observeDecision("skipped", "timing_gate_suppressed", quotes);
            logger.info(
              { chatId: cid, layer, reason: gate.reason },
              "Meta dispatch suppressed by timing gate",
            );
            return { taskId: "gate_suppressed" };
          }
        } catch (err) {
          logger.warn(
            { err, chatId: cid },
            "Meta dispatch gate failed — fail-open dispatch",
          );
        }
      }

      const quoteId = quotes[0];
      const { sanitizeContentDirection } =
        await import("../shared/message-text.js");
      const relatedQuoteIds = (args.relatedQuotes ?? [])
        .map((q) =>
          typeof q === "string" ? Number(q.replace(/^msg:/, "")) : Number(q),
        )
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
          (typeof args.targetUserId === "number" && args.targetUserId > 0
            ? args.targetUserId
            : undefined) ?? opts?.defaultTargetUserIds?.get(cid),
        trackingKey: args.trackingKey,
        createdAt: Date.now(),
        status: "queued",
        messageThreadId: args.messageThreadId,
        cognitiveAnchorEventId:
          args.cognitiveAnchorEventId ??
          opts?.defaultCognitiveAnchorEventIds?.get(cid),
      };

      // Persist the structured Meta decision before queueing. This is an
      // observe-only Agency run; legacy queue behavior remains authoritative.
      observeDecision(
        "proposed",
        undefined,
        task.quoteMessageIds ?? [],
        task.id,
      );

      const releaseQuoteClaim = async (): Promise<void> => {
        if (!quoteId) return;
        try {
          const { clearQuoteClaim } = await import("../subagent/task-store.js");
          await clearQuoteClaim(cid, quoteId, task.id);
        } catch {
          /* quote claim cleanup is best effort */
        }
      };

      // Atomic quote + chat locks BEFORE enqueue (kills same-ms double dispatch).
      try {
        const { tryClaimQuote, tryMarkCodeActActive } =
          await import("../subagent/task-store.js");
        const quoteId = quotes[0] ?? 0;
        if (quoteId > 0 && !(await tryClaimQuote(cid, quoteId, task.id))) {
          unclaim();
          observeDecision(
            "skipped",
            "quote_already_claimed",
            task.quoteMessageIds ?? [],
            task.id,
          );
          logger.info(
            { chatId: cid, quotes },
            "Meta dispatch skipped (quote already claimed)",
          );
          return { taskId: "skipped_dup" };
        }
        if (!(await tryMarkCodeActActive(cid, task.id))) {
          await releaseQuoteClaim();
          unclaim();
          observeDecision(
            "skipped",
            "active_lock_competition",
            task.quoteMessageIds ?? [],
            task.id,
          );
          logger.info(
            { chatId: cid },
            "Meta dispatch skipped (chat active lock)",
          );
          return { taskId: "skipped_busy" };
        }
      } catch (err) {
        logger.warn(
          { err, chatId: cid },
          "Meta dispatch lock failed — continuing",
        );
      }

      state.putTask(task);
      logger.info(
        {
          taskId: task.id,
          chatId: cid,
          layer,
          quotes,
          interrupt: !!args.interrupt,
        },
        "Meta dispatch.taskToGroup",
      );

      // Authority rollout owns the queue acceptance receipt. Other modes keep
      // the legacy path so shadow/advisory/canary can be measured without
      // changing user-visible dispatch behavior.
      const agencyDispatch = await dispatchCodeActTaskViaAgency(task);
      if (agencyDispatch.attempted) {
        if (agencyDispatch.accepted) return { taskId: task.id };
        task.status = "failed";
        task.resultSummary =
          `agency enqueue rejected: ${agencyDispatch.reason ?? "unknown"}`.slice(
            0,
            500,
          );
        state.putTask(task);
        try {
          const { persistCodeActTask } =
            await import("../subagent/task-store.js");
          await persistCodeActTask(task);
        } catch {
          /* task status persistence is best effort */
        }
        try {
          const { clearCodeActActive } =
            await import("../subagent/task-store.js");
          await clearCodeActActive(cid, task.id);
        } catch {
          /* active lock cleanup is best effort */
        }
        await releaseQuoteClaim();
        unclaim();
        observeDecision(
          "blocked",
          "agency_enqueue_failed",
          task.quoteMessageIds ?? [],
          task.id,
        );
        logger.warn(
          {
            taskId: task.id,
            chatId: cid,
            agencyRunId: agencyDispatch.agencyRunId,
            reason: agencyDispatch.reason,
          },
          "Meta dispatch rejected by Agency authority transport",
        );
        return { taskId: "agency_enqueue_failed" };
      }
      try {
        const { enqueueCodeActJob } = await import("../subagent/queue.js");
        await enqueueCodeActJob(task);
      } catch (err) {
        logger.warn(
          { err, taskId: task.id },
          "Meta dispatch enqueue failed — local fallback",
        );
        try {
          const { enqueueSubagentTaskLocal } =
            await import("../subagent/executor.js");
          enqueueSubagentTaskLocal(task);
        } catch (err2) {
          const { clearCodeActActive } =
            await import("../subagent/task-store.js");
          await clearCodeActActive(cid, task.id);
          await releaseQuoteClaim();
          unclaim();
          observeDecision(
            "blocked",
            "enqueue_failed",
            task.quoteMessageIds ?? [],
            task.id,
          );
          logger.warn(
            { err: err2, taskId: task.id },
            "Meta dispatch local enqueue failed",
          );
          return { taskId: "enqueue_failed" };
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
      state.todos.push({
        id,
        text: String(text).slice(0, 500),
        createdAt: Date.now(),
      });
      observeMetaAction("todo.add", "completed", undefined, {
        textChars: String(text).length,
      });
      return { id };
    },
    list() {
      observeMetaAction("todo.list");
      return [...state.todos];
    },
    remove(id: string) {
      state.todos = state.todos.filter((t) => t.id !== id);
      observeMetaAction("todo.remove", "completed", undefined, {
        idKnown: state.todos.some((t) => t.id === id),
      });
      return true;
    },
  };

  const agents = {
    listStatus() {
      observeMetaAction("agents.listStatus");
      return state
        .listTasks()
        .slice(-20)
        .map((t) => ({
          taskId: t.id,
          chatId: t.chatId,
          status: t.status,
          direction: t.contentDirection.slice(0, 80),
        }));
    },
  };

  const conversations = {
    query(hint: string) {
      observeMetaAction("conversations.query", "completed", undefined, {
        hintChars: String(hint).length,
      });
      return {
        hint: String(hint).slice(0, 200),
        note: "use dispatch; Subagent reads chat context",
      };
    },
  };

  const memory = {
    searchEntities(query: string) {
      observeMetaAction("memory.searchEntities", "completed", undefined, {
        queryChars: String(query).length,
      });
      return {
        query: String(query).slice(0, 200),
        note: "entity search runs in Subagent host.memory",
      };
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
      if (opts?.isAborted?.()) throw new Error("meta_aborted");
      const { tryWriteDreamJournal, readRecentDreamSnippet } =
        await import("../cron/dream-journal.js");
      const result = await tryWriteDreamJournal({
        slot: args?.slot,
        force: !!args?.force,
      });
      let snippet: string | null = null;
      if (result.wrote) {
        snippet = await readRecentDreamSnippet(280);
      }
      logger.info(
        { ...result, forced: !!args?.force },
        "Meta journal.tryWrite",
      );
      observeMetaAction(
        "journal.tryWrite",
        result.wrote ? "completed" : "skipped",
        result.reason,
        { forced: !!args?.force, wrote: result.wrote },
      );
      return { ...result, snippet };
    },
    async recent(maxChars?: number): Promise<{ snippet: string | null }> {
      const { readRecentDreamSnippet } =
        await import("../cron/dream-journal.js");
      const snippet = await readRecentDreamSnippet(maxChars ?? 400);
      observeMetaAction("journal.recent", "completed", undefined, {
        hasSnippet: Boolean(snippet),
      });
      return { snippet };
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
