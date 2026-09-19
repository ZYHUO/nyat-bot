import { randomUUID } from "node:crypto";
import { logger } from "../shared/logger.js";
import { getGlobalState } from "./global-state.js";
import type { DispatchTask, AttentionLayer } from "./types.js";
import { isMetaSubagentChat } from "./flags.js";
import { dispatchCodeActTaskViaAgency } from "../agent/agency-codeact-dispatch.js";
import { recordMetaDispatchObservation } from "../agent/agency-meta-observation.js";
import { recordMetaActionObservation } from "../agent/agency-meta-actions.js";
import { env } from "../env.js";
import { isKernelShadowChat, kernelShadowConfig } from "../agent/cognitive-kernel.js";
import {
  cognitiveTurnRuntime,
  type CognitiveTurn,
} from "../agent/cognitive-turn-runtime.js";

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
  const kernelTurns = new Map<string, CognitiveTurn>();
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
        // Phase 1 SocialAct shadow: keep Meta's dispatch proposal in the same
        // action ledger as Heart/Reply. The explicit env flag is checked here
        // so the default path performs no extra import, write, or provider call.
        const messageId = quoteMessageIds[0];
        let shadowEnabled = false;
        let shadowChatIds: number[] = [];
        try {
          const current = env();
          shadowEnabled = current.SOCIAL_ACT_SHADOW_ENABLED;
          shadowChatIds = current.SOCIAL_ACT_SHADOW_CHAT_IDS;
        } catch {
          shadowEnabled = false;
        }
        if (messageId !== undefined && shadowEnabled && (shadowChatIds.length === 0 || shadowChatIds.includes(cid))) {
          void import("../agent/social-act.js")
            .then(({ recordMetaSocialActShadow }) => recordMetaSocialActShadow({
              chatId: cid,
              messageId,
              layer,
              decision,
              ...(reason ? { decisionReason: reason } : {}),
              ...(args.targetUserId ? { targetUserId: args.targetUserId } : {}),
              interrupt: args.interrupt,
              ...(observationAnchor ? { cognitiveAnchorEventId: observationAnchor } : {}),
              ...(taskId ? { taskId } : {}),
              ...(args.messageThreadId ? { threadId: args.messageThreadId } : {}),
            }))
            .catch((err: unknown) => {
              logger.debug({ err, chatId: cid, messageId }, "Meta SocialAct shadow failed (non-critical)");
            });
        }

        // NyatOS runtime bridge: Meta decisions share the same trigger/frame/
        // envelope lifecycle as Telegram turns. The payload is metadata-only
        // and the legacy CodeAct queue remains the execution authority.
        let kernelEnabled = false;
        try { kernelEnabled = isKernelShadowChat(cid, kernelShadowConfig()); } catch { kernelEnabled = false; }
        if (kernelEnabled) {
          try {
            const scope = { visibility: "chat" as const, chatId: cid };
            const actionKey = `${cid}:${messageId ?? taskId ?? observationAnchor ?? "attention"}`;
            let turn = kernelTurns.get(actionKey);
            if (!turn) {
              const openedTurn = cognitiveTurnRuntime.open({
              scope,
              kind: "meta_attention",
              source: "model",
              ...(observationAnchor ? { anchorEventId: observationAnchor } : {}),
              correlationId: `kernel:meta:${cid}:${messageId ?? taskId ?? "attention"}`,
              dedupeKey: `kernel:meta:${cid}:${messageId ?? taskId ?? "attention"}`,
              metadata: {
                messageId: messageId ?? null,
                taskId: taskId ?? null,
                layer,
                decision,
                quoteCount: quoteMessageIds.length,
              },
              });
              turn = openedTurn ?? undefined;
              if (turn) kernelTurns.set(actionKey, turn);
            }
            if (turn) {
              const action = cognitiveTurnRuntime.propose(turn, {
                lane: decision === "proposed" ? "craft" : "reflection",
                kind: decision === "proposed" ? "work" : "wait",
                payload: {
                  source: "meta_dispatch",
                  decision,
                  layer,
                  messageId: messageId ?? null,
                  taskId: taskId ?? null,
                  quoteMessageIds: quoteMessageIds.slice(0, 8),
                  targetUserId: args.targetUserId ?? null,
                },
                ...(decision === "proposed"
                  ? { prediction: { expectedEffect: "queue a bounded task for the addressed chat", watchFor: ["task_receipt", "user_followup", "tool_failure"] } }
                  : {}),
                idempotencyKey: `meta-dispatch:${cid}:${messageId ?? taskId ?? observationAnchor ?? "attention"}`,
              });
              if (turn.phase !== "arbitrated" && turn.phase !== "settled" && turn.phase !== "aborted") {
                cognitiveTurnRuntime.arbitrate(turn);
              }
              if (decision !== "proposed") {
                cognitiveTurnRuntime.settle(turn, {
                  ...(action?.id || turn.selectedEnvelopeId ? { envelopeId: action?.id ?? turn.selectedEnvelopeId } : {}),
                  status: decision === "blocked" ? "blocked" : "skipped",
                  ...(reason ? { reason } : {}),
                  receipt: { stage: "meta_decision", decision, layer, messageId: messageId ?? null },
                  ...(observationAnchor ? { causationId: observationAnchor } : {}),
                });
              }
            }
          } catch (err) {
            logger.debug({ err, chatId: cid, messageId }, "Meta kernel bridge failed (non-critical)");
          }
        }
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
      const kernelTaskTurn = (): CognitiveTurn | undefined =>
        kernelTurns.get(`${cid}:${task.quoteMessageIds?.[0] ?? task.id}`);

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
        if (agencyDispatch.accepted) {
          const turn = kernelTaskTurn();
          if (turn?.selectedEnvelopeId) {
            cognitiveTurnRuntime.transition(turn, turn.selectedEnvelopeId, "accepted");
            cognitiveTurnRuntime.transition(turn, turn.selectedEnvelopeId, "dispatched");
          }
          return { taskId: task.id };
        }
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
        const turn = kernelTaskTurn();
        if (turn?.selectedEnvelopeId) cognitiveTurnRuntime.transition(turn, turn.selectedEnvelopeId, "dispatched");
      } catch (err) {
        logger.warn(
          { err, taskId: task.id },
          "Meta dispatch enqueue failed — local fallback",
        );
        try {
          const { enqueueSubagentTaskLocal } =
            await import("../subagent/executor.js");
          enqueueSubagentTaskLocal(task);
          const turn = kernelTaskTurn();
          if (turn?.selectedEnvelopeId) cognitiveTurnRuntime.transition(turn, turn.selectedEnvelopeId, "dispatched");
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

  const cognition = {
    /**
     * Persist a model-authored mission as a candidate. This is intentionally
     * not a goal/executor shortcut: only a later host-owned observation can
     * wake, verify or promote it.
     */
    async proposeMission(input: {
      chatId?: number | string;
      objective: string;
      successChecks: string[];
      watchFor?: string[];
      nextWakeAt?: number;
      deadlineAt?: number;
      budget?: { maxAttempts?: number; maxWallClockSec?: number };
    }): Promise<{ proposalId: string | null; inserted: boolean; status: 'proposed' }> {
      if (opts?.isAborted?.()) throw new Error('meta_aborted');
      const chatId = Number(input?.chatId ?? inferredChatId);
      if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('mission chatId required');
      const objective = String(input?.objective ?? '').trim().slice(0, 320);
      const successChecks = Array.isArray(input?.successChecks)
        ? input.successChecks.map((value) => String(value).trim().slice(0, 200)).filter(Boolean).slice(0, 8)
        : [];
      if (!objective || successChecks.length === 0) throw new Error('mission objective and successChecks required');
      const watchFor = Array.isArray(input.watchFor)
        ? input.watchFor.map((value) => String(value).trim().slice(0, 200)).filter(Boolean).slice(0, 8)
        : [];
      const positiveInt = (value: unknown, fallback: number, max: number): number => {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(max, parsed) : fallback;
      };
      const proposal = {
        schema: 'mission_proposal.v1' as const,
        objective,
        scope: { visibility: 'chat' as const, chatId },
        successChecks,
        watchFor,
        ...(positiveInt(input.nextWakeAt, 0, 4_102_444_800) > 0 ? { nextWakeAt: positiveInt(input.nextWakeAt, 0, 4_102_444_800) } : {}),
        ...(positiveInt(input.deadlineAt, 0, 4_102_444_800) > 0 ? { deadlineAt: positiveInt(input.deadlineAt, 0, 4_102_444_800) } : {}),
        budget: {
          maxAttempts: positiveInt(input.budget?.maxAttempts, 3, 100),
          maxWallClockSec: positiveInt(input.budget?.maxWallClockSec, 3600, 7 * 86400),
        },
        status: 'proposed' as const,
      };
      const { recordMissionProposal } = await import('../agent/nyatos-state.js');
      const recorded = recordMissionProposal(proposal, {
        source: 'model',
        correlationId: `meta:mission:${chatId}`,
      });
      observeMetaAction(
        'cognition.proposeMission',
        recorded ? (recorded.inserted ? 'completed' : 'skipped') : 'failed',
        recorded ? undefined : 'proposal_rejected',
        { chatId, successChecks: successChecks.length },
      );
      return {
        proposalId: recorded?.eventId ?? null,
        inserted: recorded?.inserted ?? false,
        status: 'proposed',
      };
    },
    /**
     * Persist a model-authored read-only observation request. The host may
     * later decide whether and how to collect it; this call never invokes a
     * sensor, fetch, memory search, or Telegram adapter.
     */
    async proposeSensor(input: {
      chatId?: number | string;
      kind: 'conversation' | 'telegram' | 'memory' | 'web' | 'relationship' | 'system';
      method: 'conversation.field' | 'telegram.recent_messages' | 'telegram.capability' | 'memory.search' | 'web.fetch' | 'relationship.snapshot' | 'system.provider_health' | 'replay.social_act';
      question: string;
      target?: string;
      prediction: string;
      stopCondition: string;
      sourceEventIds?: string[];
      expiresAt?: number;
      budget?: { maxAttempts?: number; maxWallClockSec?: number };
    }): Promise<{ proposalId: string | null; inserted: boolean; status: 'candidate' }> {
      if (opts?.isAborted?.()) throw new Error('meta_aborted');
      const chatId = Number(input?.chatId ?? inferredChatId);
      if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('sensor chatId required');
      const text = (value: unknown, max: number): string => String(value ?? '').trim().slice(0, max);
      const question = text(input?.question, 320);
      const prediction = text(input?.prediction, 320);
      const stopCondition = text(input?.stopCondition, 240);
      if (!question || !prediction || !stopCondition) throw new Error('sensor question, prediction and stopCondition required');
      const sourceEventIds = Array.isArray(input.sourceEventIds)
        ? input.sourceEventIds.map((value) => text(value, 240)).filter(Boolean).slice(0, 32)
        : [];
      const positiveInt = (value: unknown, fallback: number, max: number): number => {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(max, parsed) : fallback;
      };
      const proposal = {
        schema: 'sensor_proposal.v1' as const,
        scope: { visibility: 'chat' as const, chatId },
        kind: input.kind,
        method: input.method,
        question,
        ...(text(input.target, 240) ? { target: text(input.target, 240) } : {}),
        prediction,
        stopCondition,
        sourceEventIds,
        ...(positiveInt(input.expiresAt, 0, 4_102_444_800) > 0 ? { expiresAt: positiveInt(input.expiresAt, 0, 4_102_444_800) } : {}),
        budget: {
          maxAttempts: positiveInt(input.budget?.maxAttempts, 1, 32),
          maxWallClockSec: positiveInt(input.budget?.maxWallClockSec, 900, 7 * 86400),
        },
        status: 'candidate' as const,
      };
      const { recordSensorProposal } = await import('../agent/active-proposals.js');
      const recorded = recordSensorProposal(proposal, {
        correlationId: `meta:sensor:${chatId}`,
        causationId: opts?.defaultCognitiveAnchorEventIds?.get(chatId),
      });
      observeMetaAction(
        'cognition.proposeSensor',
        recorded ? (recorded.inserted ? 'completed' : 'skipped') : 'failed',
        recorded ? undefined : 'proposal_rejected',
        { chatId },
      );
      return { proposalId: recorded?.eventId ?? null, inserted: recorded?.inserted ?? false, status: 'candidate' };
    },
    /** Persist a self-authored interest/value hypothesis for later host evaluation. */
    async proposeValue(input: {
      chatId?: number | string;
      name: string;
      statement: string;
      reason: string;
      experiment: string;
      successChecks: string[];
      stopConditions?: string[];
      applicability?: string[];
      sourceEventIds?: string[];
      expiresAt?: number;
    }): Promise<{ proposalId: string | null; inserted: boolean; status: 'candidate' }> {
      if (opts?.isAborted?.()) throw new Error('meta_aborted');
      const chatId = Number(input?.chatId ?? inferredChatId);
      if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('value chatId required');
      const text = (value: unknown, max: number): string => String(value ?? '').trim().slice(0, max);
      const name = text(input?.name, 120);
      const statement = text(input?.statement, 320);
      const reason = text(input?.reason, 320);
      const experiment = text(input?.experiment, 320);
      const checks = Array.isArray(input.successChecks)
        ? input.successChecks.map((value) => text(value, 200)).filter(Boolean).slice(0, 8)
        : [];
      if (!name || !statement || !reason || !experiment || checks.length === 0) {
        throw new Error('value name, statement, reason, experiment and successChecks required');
      }
      const list = (values: unknown, max: number, itemMax: number): string[] => Array.isArray(values)
        ? values.map((value) => text(value, itemMax)).filter(Boolean).slice(0, max)
        : [];
      const positiveInt = (value: unknown, max: number): number | undefined => {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(max, parsed) : undefined;
      };
      const proposal = {
        schema: 'value_proposal.v1' as const,
        scope: { visibility: 'chat' as const, chatId },
        name,
        statement,
        reason,
        experiment,
        successChecks: checks,
        stopConditions: list(input.stopConditions, 8, 200),
        applicability: list(input.applicability, 8, 160),
        sourceEventIds: list(input.sourceEventIds, 32, 240),
        ...(positiveInt(input.expiresAt, 4_102_444_800) === undefined ? {} : { expiresAt: positiveInt(input.expiresAt, 4_102_444_800) }),
        status: 'candidate' as const,
      };
      const { recordValueProposal } = await import('../agent/active-proposals.js');
      const recorded = recordValueProposal(proposal, {
        correlationId: `meta:value:${chatId}`,
        causationId: opts?.defaultCognitiveAnchorEventIds?.get(chatId),
      });
      observeMetaAction(
        'cognition.proposeValue',
        recorded ? (recorded.inserted ? 'completed' : 'skipped') : 'failed',
        recorded ? undefined : 'proposal_rejected',
        { chatId },
      );
      return { proposalId: recorded?.eventId ?? null, inserted: recorded?.inserted ?? false, status: 'candidate' };
    },
    /** Record a bounded, model-authored affect episode for later expression or repair. */
    async proposeAffect(input: {
      chatId?: number | string;
      kind: 'joy' | 'hurt' | 'relief' | 'frustration' | 'curiosity' | 'loneliness' | 'pride' | 'shame' | 'calm' | 'mixed';
      intensity: number;
      valence: number;
      arousal: number;
      state: string;
      triggerEventIds?: string[];
      expressionState?: string;
    }): Promise<{ proposalId: string | null; inserted: boolean; status: 'candidate' }> {
      if (opts?.isAborted?.()) throw new Error('meta_aborted');
      const chatId = Number(input?.chatId ?? inferredChatId);
      if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('affect chatId required');
      const text = (value: unknown, max: number): string => String(value ?? '').trim().slice(0, max);
      const clamp = (value: unknown, min: number, max: number): number => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
      };
      const state = text(input?.state, 240);
      if (!state) throw new Error('affect state required');
      const startedAt = Math.floor(Date.now() / 1000);
      const triggerEventIds = Array.isArray(input.triggerEventIds)
        ? input.triggerEventIds.map((value) => text(value, 240)).filter(Boolean).slice(0, 32)
        : [];
      const episode = {
        schema: 'affect_episode.v1' as const,
        id: `affect:${chatId}:${startedAt}:${randomUUID().slice(0, 12)}`,
        scope: { visibility: 'chat' as const, chatId },
        kind: input.kind,
        intensity: clamp(input.intensity, 0, 1),
        valence: clamp(input.valence, -1, 1),
        arousal: clamp(input.arousal, 0, 1),
        startedAt,
        updatedAt: startedAt,
        status: 'active' as const,
        triggerEventIds,
        ...(text(input.expressionState, 240) ? { expressionState: text(input.expressionState, 240) } : {}),
      };
      const { recordAffectEpisode } = await import('../agent/nyatos-state.js');
      const recorded = recordAffectEpisode(episode, {
        source: 'model',
        correlationId: `meta:affect:${chatId}`,
        causationId: opts?.defaultCognitiveAnchorEventIds?.get(chatId),
      });
      observeMetaAction(
        'cognition.proposeAffect',
        recorded ? (recorded.inserted ? 'completed' : 'skipped') : 'failed',
        recorded ? undefined : 'proposal_rejected',
        { chatId, kind: input.kind },
      );
      return { proposalId: recorded?.eventId ?? null, inserted: recorded?.inserted ?? false, status: 'candidate' };
    },
    /** Propose a replayable action circuit; only the host can evaluate/publish it. */
    async proposeCircuit(input: {
      chatId?: number | string;
      name: string;
      trigger: string;
      preconditions: string[];
      steps: Array<{ action: string; purpose: string; preconditions: string[] }>;
      acceptanceChecks: string[];
      sourceEventIds?: string[];
      expiresAt?: number;
    }): Promise<{ proposalId: string | null; inserted: boolean; status: 'candidate' }> {
      if (opts?.isAborted?.()) throw new Error('meta_aborted');
      const chatId = Number(input?.chatId ?? inferredChatId);
      if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('circuit chatId required');
      const text = (value: unknown, max: number): string => String(value ?? '').trim().slice(0, max);
      const list = (values: unknown, max: number, itemMax: number): string[] => Array.isArray(values)
        ? values.map((value) => text(value, itemMax)).filter(Boolean).slice(0, max)
        : [];
      const steps = Array.isArray(input.steps)
        ? input.steps.slice(0, 8).map((step) => ({
            action: text(step?.action, 80),
            purpose: text(step?.purpose, 240),
            preconditions: list(step?.preconditions, 8, 160),
          })).filter((step) => step.action && step.purpose)
        : [];
      const name = text(input.name, 120);
      const trigger = text(input.trigger, 240);
      const preconditions = list(input.preconditions, 8, 160);
      const acceptanceChecks = list(input.acceptanceChecks, 8, 200);
      if (!name || !trigger || !steps.length || !acceptanceChecks.length) {
        throw new Error('circuit name, trigger, steps and acceptanceChecks required');
      }
      const positive = Number(input.expiresAt);
      const circuit = {
        schema: 'action_circuit.v1' as const,
        name,
        scope: { visibility: 'chat' as const, chatId },
        trigger,
        preconditions,
        steps,
        acceptanceChecks,
        sourceEventIds: list(input.sourceEventIds, 32, 240),
        ...(Number.isSafeInteger(positive) && positive > 0 ? { expiresAt: Math.min(4_102_444_800, positive) } : {}),
      };
      const { recordActionCircuitProposal } = await import('../agent/action-circuits.js');
      const recorded = recordActionCircuitProposal(circuit, {
        correlationId: `meta:circuit:${chatId}`,
        causationId: opts?.defaultCognitiveAnchorEventIds?.get(chatId),
      });
      observeMetaAction(
        'cognition.proposeCircuit',
        recorded ? (recorded.inserted ? 'completed' : 'skipped') : 'failed',
        recorded ? undefined : 'proposal_rejected',
        { chatId, steps: steps.length },
      );
      return { proposalId: recorded?.eventId ?? null, inserted: recorded?.inserted ?? false, status: 'candidate' };
    },
  };

  return {
    dispatch: Object.freeze(dispatch),
    todo: Object.freeze(todo),
    agents: Object.freeze(agents),
    conversations: Object.freeze(conversations),
    memory: Object.freeze(memory),
    journal: Object.freeze(journal),
    cognition: Object.freeze(cognition),
  };
}
