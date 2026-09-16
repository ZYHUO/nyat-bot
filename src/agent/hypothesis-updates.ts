// Host-owned Self/Person/Group/World hypothesis updates.
//
// This module is deliberately stricter than the legacy tracking writers:
// active state changes require a real source event, an allowed host-owned
// source, bounded evidence, and an idempotency key. Model self-certification
// is recorded as a candidate/rejection only.

import { getDb } from "../db/sqlite.js";
import { env } from "../env.js";
import { logger } from "../shared/logger.js";
import { applyRelationshipEvent } from "../tracking/relationship.js";
import { saveVerifiedSelfNotes } from "../tracking/self-model.js";
import { saveVerifiedGroupNorms } from "./group-norms.js";
import { upsertEntity } from "./world-state.js";
import { scopeKey, type CognitiveScope } from "../shared/cognitive-scope.js";

export type HypothesisKind = "self" | "person" | "group" | "world";
export type HypothesisSource =
  "host" | "tool" | "telegram" | "scheduler" | "import" | "model";

const ACTIVE_SOURCES: ReadonlySet<HypothesisSource> = new Set([
  "host",
  "tool",
  "telegram",
  "scheduler",
  "import",
]);

export interface HypothesisObservation {
  kind: HypothesisKind;
  scope: CognitiveScope;
  subjectKey: string;
  source: HypothesisSource;
  sourceEventId?: string;
  evidence?: Record<string, unknown>;
  counterevidence?: readonly string[];
  idempotencyKey?: string;
  notes?: readonly { note: string; evidence?: string }[];
  chatId?: number;
  userId?: number;
  relationshipDelta?: number;
  relationshipSummary?: string;
  norms?: readonly string[];
  sampleCount?: number;
  entityName?: string;
  entityKind?: "person" | "project" | "topic" | "place";
  properties?: Record<string, string>;
  confidence?: number;
  expiresAt?: number;
}

export interface HypothesisUpdateResult {
  accepted: boolean;
  status: "accepted" | "rejected" | "candidate";
  reason: string;
  auditId?: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function hasAuditTable(): boolean {
  try {
    return Boolean(
      getDb()
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hypothesis_update_audit'",
        )
        .get(),
    );
  } catch {
    return false;
  }
}

function boundedText(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, max);
}

function boundedEvidence(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 20)) {
    const safeKey = boundedText(key, 80);
    if (!safeKey) continue;
    if (typeof raw === "string") output[safeKey] = boundedText(raw, 240);
    else if (typeof raw === "number" && Number.isFinite(raw))
      output[safeKey] = raw;
    else if (typeof raw === "boolean") output[safeKey] = raw;
  }
  return output;
}

function boundedCounterevidence(
  value: readonly string[] | undefined,
): string[] {
  return (value ?? [])
    .map((item) => boundedText(item, 240))
    .filter(Boolean)
    .slice(0, 12);
}

function audit(
  observation: HypothesisObservation,
  status: HypothesisUpdateResult["status"],
  reason: string,
  idempotencyKey: string,
): HypothesisUpdateResult {
  if (!hasAuditTable())
    return { accepted: status === "accepted", status, reason };
  try {
    const db = getDb();
    db.prepare(
      `INSERT OR IGNORE INTO hypothesis_update_audit
       (idempotency_key, kind, scope_key, subject_key, source_event_id, source,
        status, reason, evidence_json, counterevidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      idempotencyKey,
      observation.kind,
      scopeKey(observation.scope),
      boundedText(observation.subjectKey, 160) || "unknown",
      boundedText(observation.sourceEventId, 240) || null,
      observation.source,
      status,
      boundedText(reason, 240) || "unspecified",
      JSON.stringify(boundedEvidence(observation.evidence)).slice(0, 2000),
      JSON.stringify(boundedCounterevidence(observation.counterevidence)).slice(
        0,
        2000,
      ),
      nowSec(),
    );
    const row = db
      .prepare(
        "SELECT id FROM hypothesis_update_audit WHERE idempotency_key = ?",
      )
      .get(idempotencyKey) as { id?: number } | undefined;
    return {
      accepted: status === "accepted",
      status,
      reason,
      ...(row?.id ? { auditId: row.id } : {}),
    };
  } catch (error) {
    logger.warn(
      {
        err: error,
        kind: observation.kind,
        subjectKey: observation.subjectKey,
      },
      "hypothesis audit write failed",
    );
    return {
      accepted: false,
      status: "rejected",
      reason: "hypothesis_audit_unavailable",
    };
  }
}

function existingAudit(idempotencyKey: string): HypothesisUpdateResult | null {
  if (!hasAuditTable()) return null;
  try {
    const row = getDb()
      .prepare(
        "SELECT id, status, reason FROM hypothesis_update_audit WHERE idempotency_key = ?",
      )
      .get(idempotencyKey) as
      | {
          id?: number;
          status?: HypothesisUpdateResult["status"];
          reason?: string;
        }
      | undefined;
    if (!row?.status) return null;
    return {
      accepted: row.status === "accepted",
      status: row.status,
      reason: row.reason ?? "already_recorded",
      ...(row.id ? { auditId: row.id } : {}),
    };
  } catch {
    return null;
  }
}

function normalizeIdempotencyKey(observation: HypothesisObservation): string {
  return boundedText(
    observation.idempotencyKey ||
      `${observation.kind}:${scopeKey(observation.scope)}:${observation.subjectKey}:${observation.sourceEventId ?? "no-event"}`,
    240,
  );
}

/** Record an LLM/model proposal without allowing it into active state. */
export function recordHypothesisCandidate(input: {
  kind: HypothesisKind;
  scope: CognitiveScope;
  subjectKey: string;
  sourceEventId?: string;
  source?: HypothesisSource;
  evidence?: Record<string, unknown>;
  reason?: string;
}): HypothesisUpdateResult {
  const source = input.source ?? "model";
  const observation: HypothesisObservation = {
    ...input,
    source,
    idempotencyKey: `candidate:${input.kind}:${scopeKey(input.scope)}:${input.subjectKey}:${input.sourceEventId ?? nowSec()}`,
  };
  return audit(
    observation,
    source === "model" ? "candidate" : "rejected",
    input.reason ?? "model_output_not_host_evidence",
    normalizeIdempotencyKey(observation),
  );
}

/** Apply one bounded observation to exactly one hypothesis family. */
export function applyHypothesisObservation(
  observation: HypothesisObservation,
): HypothesisUpdateResult {
  const sourceEventId = boundedText(observation.sourceEventId, 240);
  const subjectKey = boundedText(observation.subjectKey, 160);
  const idempotencyKey = normalizeIdempotencyKey(observation);
  const prior = existingAudit(idempotencyKey);
  if (prior) return prior;
  if (!subjectKey)
    return audit(observation, "rejected", "subject_missing", idempotencyKey);
  if (!sourceEventId)
    return audit(
      observation,
      observation.source === "model" ? "candidate" : "rejected",
      "source_event_required",
      idempotencyKey,
    );
  if (observation.source === "model")
    return audit(
      observation,
      "candidate",
      "model_self_certification_rejected",
      idempotencyKey,
    );
  if (!ACTIVE_SOURCES.has(observation.source))
    return audit(
      observation,
      "rejected",
      "source_not_host_owned",
      idempotencyKey,
    );

  const evidence = boundedEvidence(observation.evidence);
  if (Object.keys(evidence).length === 0)
    return audit(observation, "rejected", "evidence_required", idempotencyKey);
  const counterevidence = boundedCounterevidence(observation.counterevidence);
  if (
    counterevidence.length === 0 &&
    typeof evidence["counterevidence"] === "string"
  ) {
    counterevidence.push(boundedText(evidence["counterevidence"], 240));
  }

  try {
    if (observation.kind === "self") {
      const notes = observation.notes ?? [];
      if (!notes.length)
        return audit(
          observation,
          "rejected",
          "self_note_required",
          idempotencyKey,
        );
      const saved = saveVerifiedSelfNotes(notes, {
        sourceEventId,
        source: observation.source,
        evidence,
      });
      if (saved === 0)
        return audit(
          observation,
          "rejected",
          "self_note_rejected",
          idempotencyKey,
        );
    } else if (observation.kind === "person") {
      const chatId = observation.chatId;
      const userId = observation.userId;
      if (
        typeof chatId !== "number" ||
        typeof userId !== "number" ||
        !Number.isSafeInteger(chatId) ||
        !Number.isSafeInteger(userId)
      ) {
        return audit(
          observation,
          "rejected",
          "person_scope_required",
          idempotencyKey,
        );
      }
      const relationshipDelta = observation.relationshipDelta;
      if (!env().RELATIONSHIP_ENABLED) {
        return audit(
          observation,
          "rejected",
          "relationship_feature_disabled",
          idempotencyKey,
        );
      }
      if (
        typeof relationshipDelta !== "number" ||
        !Number.isFinite(relationshipDelta)
      ) {
        return audit(
          observation,
          "rejected",
          "relationship_delta_required",
          idempotencyKey,
        );
      }
      applyRelationshipEvent(
        chatId,
        userId,
        relationshipDelta,
        boundedText(observation.relationshipSummary, 200) ||
          `evidence:${sourceEventId}`,
      );
    } else if (observation.kind === "group") {
      const chatId = observation.chatId;
      const sampleCount = observation.sampleCount;
      if (
        typeof chatId !== "number" ||
        !Number.isSafeInteger(chatId) ||
        chatId >= 0
      )
        return audit(
          observation,
          "rejected",
          "group_scope_required",
          idempotencyKey,
        );
      const norms = (observation.norms ?? [])
        .map((item) => boundedText(item, 80))
        .filter((item) => item.length >= 2)
        .slice(0, 5);
      if (
        !norms.length ||
        typeof sampleCount !== "number" ||
        !Number.isSafeInteger(sampleCount) ||
        sampleCount < 5
      ) {
        return audit(
          observation,
          "rejected",
          "group_evidence_threshold_not_met",
          idempotencyKey,
        );
      }
      const saved = saveVerifiedGroupNorms(chatId, norms, sampleCount, {
        sourceEventId,
        source: observation.source,
        evidence,
      });
      if (!saved)
        return audit(
          observation,
          "rejected",
          "group_update_rejected",
          idempotencyKey,
        );
    } else {
      if (
        !observation.entityName ||
        !observation.entityKind ||
        !observation.properties ||
        !Object.keys(observation.properties).length
      ) {
        return audit(
          observation,
          "rejected",
          "world_observation_required",
          idempotencyKey,
        );
      }
      const entityId = upsertEntity(
        boundedText(observation.entityName, 100),
        observation.entityKind,
        Object.fromEntries(
          Object.entries(observation.properties)
            .slice(0, 20)
            .map(([key, value]) => [
              boundedText(key, 80),
              boundedText(value, 160),
            ]),
        ),
        observation.chatId ?? observation.scope.chatId ?? null,
        observation.scope,
        {
          sourceEventId,
          confidence: observation.confidence,
          expiresAt: observation.expiresAt,
        },
      );
      if (!entityId)
        return audit(
          observation,
          "rejected",
          "world_update_rejected",
          idempotencyKey,
        );
    }
    return audit(
      observation,
      "accepted",
      counterevidence.length > 0
        ? "host_evidence_applied_with_counterevidence"
        : "host_evidence_applied",
      idempotencyKey,
    );
  } catch (error) {
    logger.warn(
      { err: error, kind: observation.kind, subjectKey },
      "hypothesis update failed",
    );
    return audit(
      observation,
      "rejected",
      "hypothesis_update_failed",
      idempotencyKey,
    );
  }
}

export function listHypothesisUpdateAudit(
  limit = 100,
): Array<Record<string, unknown>> {
  if (!hasAuditTable()) return [];
  try {
    const take = Math.min(500, Math.max(1, Math.trunc(limit)));
    return getDb()
      .prepare(
        `SELECT id, idempotency_key, kind, scope_key, subject_key, source_event_id,
              source, status, reason, created_at
         FROM hypothesis_update_audit ORDER BY id DESC LIMIT ?`,
      )
      .all(take) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}
