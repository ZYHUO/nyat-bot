// Deterministic projection for durable cognitive events.
// This module is deliberately side-effect narrow: it can settle a prediction
// from an observed feedback event and create an explicitly sourced debt, but it
// never grants permission, sends a message, or treats model text as proof.

import { getDb } from "../db/sqlite.js";
import { logger } from "../shared/logger.js";
import {
  createDebt,
  resolveDebtWithEvidence,
  resolveOpenDebtsByTaskWithEvidence,
} from "./cognitive-debts.js";
import { resolvePrediction } from "./predictions.js";
import { getCognitiveEvent } from "./cognitive-events.js";
import { applyHypothesisObservation } from "./hypothesis-updates.js";
import type { CognitiveEvent } from "./cognitive-events.js";
import type { CognitiveOutboxItem } from "./cognitive-events.js";

export interface CognitiveProjectionOptions {
  /** Creation is opt-in at the worker boundary; no auto-repay is provided. */
  createDebts?: boolean;
}

export interface CognitiveProjectionResult {
  eventId: string;
  predictionFeedbackSeen: boolean;
  debtsCreated: number;
  debtsResolved: number;
  worldChangeProjected: number;
  hypothesisUpdates: number;
  toolCallbackProjected: number;
  ignored: boolean;
}

function factText(event: CognitiveEvent, key: string): string {
  const value = event.fact[key];
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function factNumber(event: CognitiveEvent, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = event.fact[key];
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : NaN;
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function factSentiment(event: CognitiveEvent): number | null {
  const value = event.fact["actualSentiment"] ?? event.fact["sentiment"];
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? Math.min(1, Math.max(-1, parsed)) : null;
}

function factProperties(event: CognitiveEvent): Record<string, string> {
  const value = event.fact["properties"];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const properties: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 20)) {
    if (!/^[^\u0000-\u001f]{1,80}$/.test(key) || typeof raw !== "string")
      continue;
    const text = raw
      .replace(/[\u0000-\u001f]/g, "")
      .trim()
      .slice(0, 160);
    if (text) properties[key] = text;
  }
  return properties;
}

function hasWorldRevisionForEvent(event: CognitiveEvent): boolean {
  try {
    const db = getDb();
    const table = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'world_entity_revisions'",
      )
      .get();
    if (!table) return false;
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM world_entity_revisions WHERE source_event_id = ? LIMIT 1",
        )
        .get(event.id),
    );
  } catch {
    return false;
  }
}

function sourceEventIds(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .filter((item): item is string => typeof item === "string")
          .slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

function isSource(
  event: CognitiveEvent,
  ...sources: CognitiveEvent["source"][]
): boolean {
  return sources.includes(event.source);
}

/**
 * A successful tool callback is evidence for one previous tool failure, not
 * evidence that the whole task succeeded. Match only the same task/chat and
 * tool name, and settle the newest source failure with this callback id.
 */
function projectSuccessfulToolCallback(event: CognitiveEvent): number {
  if (
    event.type !== "task_observation" ||
    event.source !== "tool" ||
    !event.taskId ||
    !event.chatId
  )
    return 0;
  if (
    factText(event, "kind") !== "tool_finished" ||
    factText(event, "errorCode")
  )
    return 0;
  const toolName = factText(event, "toolName");
  const invocationId = factText(event, "invocationId");
  if (!toolName || !invocationId) return 0;
  try {
    const rows = getDb()
      .prepare(
        `SELECT id, source_event_ids FROM cognitive_debts
       WHERE chat_id = ? AND task_id = ? AND kind = 'uncertainty' AND status = 'open'
       ORDER BY updated_at DESC, id DESC LIMIT 100`,
      )
      .all(event.chatId, event.taskId) as Array<{
      id?: number;
      source_event_ids?: unknown;
    }>;
    for (const row of rows) {
      const sourceId = sourceEventIds(row.source_event_ids)[0];
      if (!sourceId) continue;
      const source = getCognitiveEvent(sourceId);
      if (
        !source ||
        source.type !== "tool_failure" ||
        source.taskId !== event.taskId ||
        source.chatId !== event.chatId
      )
        continue;
      if (
        factText(source, "kind") !== "tool_finished" ||
        factText(source, "toolName") !== toolName
      )
        continue;
      if (
        !factText(source, "errorCode") ||
        factText(source, "invocationId") === invocationId
      )
        continue;
      if (
        row.id &&
        resolveDebtWithEvidence({
          id: row.id,
          resolution: `工具 ${toolName} 后续调用已成功返回`,
          resolutionEventId: event.id,
          scope: {
            visibility: "task",
            chatId: event.chatId,
            taskId: event.taskId,
          },
        })
      )
        return 1;
    }
  } catch (err) {
    logger.debug(
      { err, eventId: event.id },
      "successful tool callback projection failed",
    );
  }
  return 0;
}

function projectWorldChange(event: CognitiveEvent): boolean {
  if (
    event.type !== "world_change" ||
    event.visibility !== "chat" ||
    !event.chatId
  )
    return false;
  // Model-authored world facts are hypotheses, not host-observable changes.
  if (
    event.source !== "host" &&
    event.source !== "tool" &&
    event.source !== "scheduler"
  )
    return false;
  const name = factText(event, "entityName") || factText(event, "name");
  const kind = factText(event, "entityKind") || factText(event, "kind");
  if (!name || !["person", "project", "topic", "place"].includes(kind))
    return false;
  if (hasWorldRevisionForEvent(event)) return false;
  const properties = factProperties(event);
  if (!Object.keys(properties).length) return false;
  const confidenceRaw = event.fact["confidence"];
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : 0.5;
  const expiresRaw = event.fact["expiresAt"];
  const expiresAt =
    typeof expiresRaw === "number" &&
    Number.isSafeInteger(expiresRaw) &&
    expiresRaw > 0
      ? expiresRaw
      : undefined;
  return applyHypothesisObservation({
    kind: "world",
    scope: { visibility: "chat", chatId: event.chatId },
    subjectKey: `${kind}:${name}`,
    source: event.source,
    sourceEventId: event.id,
    evidence: { properties, confidence },
    chatId: event.chatId,
    entityName: name,
    entityKind: kind as "person" | "project" | "topic" | "place",
    properties,
    confidence,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }).accepted;
}

function projectExplicitHypothesis(event: CognitiveEvent): number {
  const kind = factText(event, "hypothesisKind");
  if (!["self", "person", "group", "world"].includes(kind)) return 0;
  if (event.visibility !== "global" && event.chatId === null) return 0;
  const evidence = event.fact["evidence"];
  const boundedEvidence =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : {};
  const result = applyHypothesisObservation({
    kind: kind as "self" | "person" | "group" | "world",
    scope:
      event.visibility === "global"
        ? { visibility: "global" }
        : {
            visibility: event.visibility,
            ...(event.chatId !== null ? { chatId: event.chatId } : {}),
            ...(event.userId !== null ? { userId: event.userId } : {}),
            ...(event.taskId ? { taskId: event.taskId } : {}),
          },
    subjectKey: factText(event, "hypothesisSubject") || `${kind}:${event.id}`,
    source: event.source,
    sourceEventId: event.id,
    evidence: boundedEvidence,
    counterevidence: Array.isArray(event.fact["counterevidence"])
      ? event.fact["counterevidence"]
          .filter((item): item is string => typeof item === "string")
          .slice(0, 12)
      : undefined,
    chatId: event.chatId ?? undefined,
    userId: event.userId ?? undefined,
    relationshipDelta:
      typeof event.fact["relationshipDelta"] === "number"
        ? event.fact["relationshipDelta"]
        : undefined,
    relationshipSummary: factText(event, "relationshipSummary"),
    norms: Array.isArray(event.fact["norms"])
      ? event.fact["norms"].filter(
          (item): item is string => typeof item === "string",
        )
      : undefined,
    sampleCount: factNumber(event, "sampleCount") ?? undefined,
    notes: Array.isArray(event.fact["notes"])
      ? event.fact["notes"]
          .filter(
            (item): item is { note: string; evidence?: string } =>
              typeof item === "object" &&
              item !== null &&
              typeof (item as Record<string, unknown>)["note"] === "string",
          )
          .map((item) => ({
            note: String(item.note),
            ...(item.evidence ? { evidence: String(item.evidence) } : {}),
          }))
      : undefined,
    entityName: factText(event, "entityName"),
    entityKind: (["person", "project", "topic", "place"] as const).find(
      (value) => value === factText(event, "entityKind"),
    ),
    properties: factProperties(event),
  });
  return result.accepted ? 1 : 0;
}

function hasDebtForEvent(event: CognitiveEvent, kind: string): boolean {
  if (!event.chatId) return false;
  try {
    const rows = getDb()
      .prepare(
        "SELECT source_event_ids FROM cognitive_debts WHERE chat_id = ? AND kind = ? ORDER BY id DESC LIMIT 50",
      )
      .all(event.chatId, kind) as Array<{ source_event_ids?: unknown }>;
    return rows.some((row) => {
      try {
        const ids = JSON.parse(String(row.source_event_ids ?? "[]")) as unknown;
        return Array.isArray(ids) && ids.includes(event.id);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function debtSpec(event: CognitiveEvent): {
  kind: "correction" | "uncertainty" | "unfinished_task" | "stale_belief";
  statement: string;
  priority: number;
  confidence: number;
} | null {
  if (
    event.type === "user_correction" &&
    !isSource(event, "telegram", "import")
  )
    return null;
  if (
    event.type === "user_stop" &&
    !isSource(event, "telegram", "host", "import")
  )
    return null;
  if (
    event.type === "user_goal_change" &&
    !isSource(event, "telegram", "host", "import")
  )
    return null;
  if (
    event.type === "tool_failure" &&
    !isSource(event, "tool", "host", "scheduler", "import")
  )
    return null;
  if (
    event.type === "task_observation" &&
    !isSource(event, "host", "tool", "scheduler", "import")
  )
    return null;
  if (
    event.type === "world_change" &&
    !isSource(event, "host", "tool", "scheduler")
  )
    return null;
  const detail =
    factText(event, "toolName") ||
    factText(event, "errorCode") ||
    factText(event, "reason");
  if (event.type === "user_correction") {
    return {
      kind: "correction",
      statement: detail
        ? `用户纠正了先前判断，需要重新核实（${detail}）`
        : "用户纠正了先前判断，需要重新核实",
      priority: 8,
      confidence: 0.9,
    };
  }
  if (event.type === "tool_failure") {
    if (factText(event, "kind") === "task_failed") {
      if (
        factText(event, "resultSummary") === "failed_user_stopped" ||
        factText(event, "resultSummary") === "user_stopped"
      ) {
        return null;
      }
      return {
        kind: "unfinished_task",
        statement: detail
          ? `任务未完成，需要重新处理（${detail}）`
          : "任务未完成，需要重新处理",
        priority: 8,
        confidence: 0.9,
      };
    }
    return {
      kind: "uncertainty",
      statement: detail
        ? `工具结果未取得，需要重新核实（${detail}）`
        : "工具结果未取得，需要重新核实",
      priority: 7,
      confidence: 0.8,
    };
  }
  if (event.type === "user_stop") {
    return {
      kind: "unfinished_task",
      statement: "任务被用户停止，后续是否恢复仍未确定",
      priority: 7,
      confidence: 0.95,
    };
  }
  if (event.type === "user_goal_change") {
    return {
      kind: "uncertainty",
      statement: "用户目标发生变化，需要确认当前目标和旧计划的关系",
      priority: 7,
      confidence: 0.75,
    };
  }
  if (event.type === "world_change") {
    return {
      kind: "stale_belief",
      statement: "世界状态发生变化，相关旧信念需要重新验证",
      priority: 5,
      confidence: 0.65,
    };
  }
  if (event.type === "task_observation") {
    const kind = factText(event, "kind");
    if (
      kind === "task_failed" ||
      kind === "task_waiting_user" ||
      kind === "task_queued"
    ) {
      return {
        kind: "unfinished_task",
        statement:
          kind === "task_waiting_user"
            ? "任务等待用户输入，尚未完成"
            : "任务尚未得到外部验收的完成结果",
        priority: kind === "task_failed" ? 8 : 6,
        confidence: 0.9,
      };
    }
  }
  return null;
}

function createDebtForEvent(event: CognitiveEvent): number {
  if (!event.chatId) return 0;
  const spec = debtSpec(event);
  if (!spec || hasDebtForEvent(event, spec.kind)) return 0;
  const id = createDebt({
    chatId: event.chatId,
    ownerUid: event.userId ?? undefined,
    taskId: event.taskId ?? undefined,
    kind: spec.kind,
    statement: spec.statement,
    sourceEventIds: [event.id],
    priority: spec.priority,
    confidence: spec.confidence,
    ttlSec: spec.kind === "stale_belief" ? 7 * 24 * 3600 : 3 * 24 * 3600,
    nextCheckInSec: 15 * 60,
    dedupeKey: `event-debt:${event.id}:${spec.kind}`,
  });
  return id ? 1 : 0;
}

function projectPredictionFeedback(event: CognitiveEvent): boolean {
  if (event.type !== "user_reaction" && event.type !== "user_followup")
    return false;
  if (!isSource(event, "telegram", "import")) return false;
  const messageId = factNumber(event, "botMessageId", "messageId");
  const actualSentiment = factSentiment(event);
  if (!event.chatId || !messageId || actualSentiment === null) return false;
  resolvePrediction({
    chatId: event.chatId,
    messageId,
    actualSentiment,
    feedbackKind: factText(event, "feedbackKind") || event.type,
    outcomeEventId: event.id,
  });
  return true;
}

function projectDebtResolution(event: CognitiveEvent): number {
  if (!isSource(event, "telegram", "host", "tool", "scheduler", "import"))
    return 0;
  const resolution =
    factText(event, "resolution") || factText(event, "resolutionEvidence");
  if (!resolution || !event.chatId) return 0;
  const explicitId = factNumber(event, "resolvesDebtId", "debtId");
  if (explicitId) {
    return resolveDebtWithEvidence({
      id: explicitId,
      resolution,
      resolutionEventId: event.id,
      scope: {
        visibility: event.taskId ? "task" : "chat",
        chatId: event.chatId,
        ...(event.userId ? { userId: event.userId } : {}),
        ...(event.taskId ? { taskId: event.taskId } : {}),
      },
    })
      ? 1
      : 0;
  }
  const observationKind = factText(event, "kind");
  const verifiedCompletion =
    observationKind === "task_completed" &&
    factText(event, "assessmentStatus") === "verified";
  const clarification = observationKind === "user_clarification_received";
  if (
    event.type === "task_observation" &&
    event.taskId &&
    (verifiedCompletion || clarification)
  ) {
    return resolveOpenDebtsByTaskWithEvidence({
      taskId: event.taskId,
      chatId: event.chatId,
      resolution,
      resolutionEventId: event.id,
    });
  }
  if (event.type === "user_stop" && event.taskId && resolution) {
    return resolveOpenDebtsByTaskWithEvidence({
      taskId: event.taskId,
      chatId: event.chatId,
      resolution,
      resolutionEventId: event.id,
    });
  }
  return 0;
}

/** Apply only deterministic, host-observable consequences of one event. */
export function projectCognitiveEvent(
  event: CognitiveEvent,
  options: CognitiveProjectionOptions = {},
): CognitiveProjectionResult {
  try {
    const predictionFeedbackSeen = projectPredictionFeedback(event);
    const worldChangeProjected = projectWorldChange(event) ? 1 : 0;
    const hypothesisUpdates = projectExplicitHypothesis(event);
    const debtsCreated =
      options.createDebts === false ? 0 : createDebtForEvent(event);
    const debtsResolved = projectDebtResolution(event);
    const toolCallbackProjected = projectSuccessfulToolCallback(event);
    return {
      eventId: event.id,
      predictionFeedbackSeen,
      debtsCreated,
      debtsResolved,
      worldChangeProjected,
      hypothesisUpdates,
      toolCallbackProjected,
      ignored:
        !predictionFeedbackSeen &&
        debtsCreated === 0 &&
        debtsResolved === 0 &&
        worldChangeProjected === 0 &&
        toolCallbackProjected === 0 &&
        hypothesisUpdates === 0,
    };
  } catch (error) {
    logger.warn(
      { err: error, eventId: event.id, type: event.type },
      "cognitive event projection failed",
    );
    return {
      eventId: event.id,
      predictionFeedbackSeen: false,
      debtsCreated: 0,
      debtsResolved: 0,
      worldChangeProjected: 0,
      hypothesisUpdates: 0,
      toolCallbackProjected: 0,
      ignored: true,
    };
  }
}

/** Adapter shape for `drainCognitiveOutbox`. */
export async function projectCognitiveOutboxItem(
  item: CognitiveOutboxItem,
  options: CognitiveProjectionOptions = {},
): Promise<CognitiveProjectionResult> {
  if (!item.event) throw new Error("cognitive event missing for outbox item");
  return projectCognitiveEvent(item.event, options);
}
