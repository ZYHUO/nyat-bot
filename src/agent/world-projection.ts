// Scoped Self/Person/Group/World projection facade.
//
// The underlying tracking tables remain the source of truth. This module only
// turns their bounded, visibility-checked rows into one hypothesis manifest for
// the cognitive workspace. It never writes memory, grants authority, or treats
// model-authored summaries as verified facts.

import { getDb } from "../db/sqlite.js";
import { getActiveSelfNotes } from "../tracking/self-model.js";
import {
  getProfileSections,
  getUserProfilePrompt,
} from "../tracking/user-profile.js";
import { getGroupNorms } from "./group-norms.js";
import {
  getRelationship,
  getRelationshipAt,
} from "../tracking/relationship.js";
import {
  findEntities,
  listEntityRevisions,
  type WorldEntity,
} from "./world-state.js";
import { scopeKey } from "../shared/cognitive-scope.js";
import type { CognitiveScope } from "../shared/cognitive-scope.js";

export type ProjectionKind = "self" | "person" | "group" | "world";
export type ProjectionStatus = "active" | "stale" | "unverified";

export interface ProjectionHypothesis {
  id: string;
  kind: ProjectionKind;
  subject: string;
  statement: string;
  source: string;
  scopeKey: string;
  confidence: number;
  status: ProjectionStatus;
  evidence: string[];
  updatedAt: number;
  expiresAt: number | null;
}

export interface WorldProjectionBudget {
  maxSelf?: number;
  maxPerson?: number;
  maxGroup?: number;
  maxWorld?: number;
  /** Historical event timestamp; current rows newer than this are excluded or reconstructed. */
  asOf?: number;
}

export interface ScopedWorldProjection {
  scope: CognitiveScope;
  self: ProjectionHypothesis[];
  person: ProjectionHypothesis[];
  group: ProjectionHypothesis[];
  world: ProjectionHypothesis[];
  /** Accepted entity rows, retained so workspace consumers do not query twice. */
  worldEntities: WorldEntity[];
  uncertainties: string[];
}

const DAY_SEC = 24 * 3600;
const PROFILE_TTL_SEC = 30 * DAY_SEC;
const GROUP_NORMS_TTL_SEC = 6 * 3600;
const DEFAULT_BUDGET: Required<Omit<WorldProjectionBudget, "asOf">> = {
  maxSelf: 3,
  maxPerson: 2,
  maxGroup: 1,
  maxWorld: 6,
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function boundedCount(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

type NormalizedWorldProjectionBudget = Required<
  Omit<WorldProjectionBudget, "asOf">
> & { asOf?: number };

function normalizeBudget(
  input: WorldProjectionBudget,
): NormalizedWorldProjectionBudget {
  const asOf =
    Number.isSafeInteger(input.asOf) && (input.asOf as number) > 0
      ? input.asOf
      : undefined;
  return {
    maxSelf: boundedCount(input.maxSelf, DEFAULT_BUDGET.maxSelf, 20),
    maxPerson: boundedCount(input.maxPerson, DEFAULT_BUDGET.maxPerson, 10),
    maxGroup: boundedCount(input.maxGroup, DEFAULT_BUDGET.maxGroup, 5),
    maxWorld: boundedCount(input.maxWorld, DEFAULT_BUDGET.maxWorld, 50),
    asOf,
  };
}

function safeText(value: unknown, max = 400): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .slice(0, max);
}

function safeEvidence(value: unknown, fallback: string): string[] {
  const evidence = safeText(value, 240);
  return [evidence || fallback];
}

function clampConfidence(value: unknown, fallback = 0.5): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function validChatScope(scope: CognitiveScope): boolean {
  if (
    !scope ||
    scope.visibility === "global" ||
    !Number.isSafeInteger(scope.chatId) ||
    scope.chatId === 0
  )
    return false;
  try {
    scopeKey(scope);
    return true;
  } catch {
    return false;
  }
}

function hasColumn(table: string, column: string): boolean {
  try {
    return (
      getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name?: string;
      }>
    ).some((item) => item.name === column);
  } catch {
    return false;
  }
}

function profileMeta(
  chatId: number,
  userId: number,
  asOf?: number,
): { updatedAt: number; stale: boolean } {
  try {
    const fields = ["updated_at"];
    const hasStale = hasColumn("user_profiles", "stale");
    if (hasStale) fields.push("stale");
    const asOfClause = asOf === undefined ? "" : " AND updated_at <= ?";
    const params =
      asOf === undefined ? [chatId, userId] : [chatId, userId, asOf];
    const row = getDb()
      .prepare(
        `SELECT ${fields.join(", ")} FROM user_profiles WHERE chat_id = ? AND uid = ?${asOfClause}`,
      )
      .get(...params) as { updated_at?: number; stale?: number } | undefined;
    const updatedAt = Number(row?.updated_at);
    return {
      updatedAt:
        Number.isSafeInteger(updatedAt) && updatedAt > 0 ? updatedAt : nowSec(),
      stale: hasStale && Number(row?.stale ?? 0) === 1,
    };
  } catch {
    return { updatedAt: nowSec(), stale: false };
  }
}

function profileStatement(
  chatId: number,
  userId: number,
  asOf?: number,
): string {
  let profile = "";
  try {
    profile = safeText(getUserProfilePrompt(chatId, userId, asOf), 480);
  } catch {
    profile = "";
  }
  if (profile) return profile;
  try {
    const sections = getProfileSections(chatId, userId, asOf);
    return sections
      .slice(0, 8)
      .map((section) => {
        const bullets = section.bullets
          .slice(0, 3)
          .map((bullet) => safeText(bullet, 120))
          .filter(Boolean);
        return bullets.length
          ? `${safeText(section.section_name, 50)}: ${bullets.join("；")}`
          : "";
      })
      .filter(Boolean)
      .join("\n")
      .slice(0, 480);
  } catch {
    return "";
  }
}

function buildSelf(
  limit: number,
  uncertainties: string[],
  asOf?: number,
): ProjectionHypothesis[] {
  try {
    const hypotheses: ProjectionHypothesis[] = [];
    for (const note of getActiveSelfNotes(limit, asOf)) {
      const statement = safeText(note.note, 360);
      const updatedAt = Number(note.created_at);
      if (!statement || !Number.isSafeInteger(note.id) || note.id <= 0)
        continue;
      hypotheses.push({
        id: `self:${note.id}`,
        kind: "self",
        subject: "bot",
        statement,
        source: `self_model_notes:${note.id}`,
        scopeKey: "global",
        confidence: note.verified === 1 ? 0.8 : 0.5,
        status: note.verified === 1 ? "active" : "unverified",
        evidence: safeEvidence(note.evidence, `self_model:${note.id}`),
        updatedAt:
          Number.isSafeInteger(updatedAt) && updatedAt > 0
            ? updatedAt
            : nowSec(),
        expiresAt: null,
      });
    }
    return hypotheses;
  } catch {
    uncertainties.push("Self 投影暂时不可用，当前回合不把旧自我笔记当作事实。");
    return [];
  }
}

function buildPerson(
  scope: CognitiveScope,
  limit: number,
  uncertainties: string[],
  asOf?: number,
): ProjectionHypothesis[] {
  if (
    !Number.isSafeInteger(scope.chatId) ||
    scope.chatId === 0 ||
    !Number.isSafeInteger(scope.userId) ||
    scope.userId === 0
  )
    return [];
  const chatId = scope.chatId as number;
  const userId = scope.userId as number;
  const profile = profileStatement(chatId, userId, asOf);
  // Relationship facts are scoped to (chat, user). Historical projections use
  // the append-only ledger so a current mutable row cannot leak into replay.
  let relationshipLine = "";
  let relationshipEvidence: string | undefined;
  if (asOf === undefined) {
    try {
      const relationship = getRelationship(chatId, userId);
      if (relationship.count > 0) {
        relationshipLine = `互动记录：已互动 ${Math.min(relationship.count, 10000)} 次，当前关系标签为「${relationship.bucket}」。`;
        relationshipEvidence = `chat_relationships:${chatId}:${userId}`;
      }
    } catch {
      /* relationship is an optional enrichment */
    }
  } else {
    try {
      const relationship = getRelationshipAt(chatId, userId, asOf);
      if (relationship === null) {
        uncertainties.push(
          `用户关系统计缺少历史 revision，事件锚点不读取当前关系（uid:${userId}@chat:${chatId}）。`,
        );
      } else if (relationship.count > 0) {
        relationshipLine = `互动记录：截至事件锚点已互动 ${Math.min(relationship.count, 10000)} 次，锚点关系标签为「${relationship.bucket}」。`;
        relationshipEvidence = `chat_relationship_revisions:${chatId}:${userId}`;
      }
    } catch {
      uncertainties.push(
        `用户关系统计暂时不可用，事件锚点不读取当前关系（uid:${userId}@chat:${chatId}）。`,
      );
    }
  }
  const statement = [profile, relationshipLine]
    .filter(Boolean)
    .join("\n")
    .slice(0, 480);
  if (!statement) return [];
  const meta = profileMeta(chatId, userId, asOf);
  const now = asOf ?? nowSec();
  const expiresAt = meta.updatedAt + PROFILE_TTL_SEC;
  const stale = meta.stale || expiresAt <= now;
  if (stale)
    uncertainties.push(`用户画像可能已过期（uid:${userId}@chat:${chatId}）。`);
  const hypothesis: ProjectionHypothesis = {
    id: `person:${chatId}:${userId}`,
    kind: "person",
    subject: `uid:${userId}`,
    statement,
    source: `user_profiles:${chatId}:${userId}`,
    scopeKey: scopeKey({ visibility: "user", chatId, userId }),
    confidence: stale ? 0.25 : 0.55,
    status: stale ? "stale" : "unverified",
    evidence: [
      ...(profile ? [`profile:${chatId}:${userId}`] : []),
      ...(relationshipEvidence ? [relationshipEvidence] : []),
    ],
    updatedAt: meta.updatedAt,
    expiresAt,
  };
  return [hypothesis].slice(0, limit);
}

function buildGroup(
  scope: CognitiveScope,
  limit: number,
  uncertainties: string[],
  asOf?: number,
): ProjectionHypothesis[] {
  if (
    !Number.isSafeInteger(scope.chatId) ||
    typeof scope.chatId !== "number" ||
    scope.chatId >= 0
  )
    return [];
  const chatId = scope.chatId;
  try {
    const norms = getGroupNorms(chatId, asOf);
    const statements =
      norms?.norms.map((norm) => safeText(norm, 100)).filter(Boolean) ?? [];
    if (!norms || !statements.length) return [];
    const updatedAt =
      Number.isSafeInteger(norms.lastUpdatedAt) && norms.lastUpdatedAt > 0
        ? norms.lastUpdatedAt
        : nowSec();
    const expiresAt = updatedAt + GROUP_NORMS_TTL_SEC;
    const stale = expiresAt <= (asOf ?? nowSec());
    if (stale) uncertainties.push(`群规范可能已过期（chat:${chatId}）。`);
    const sampleCount = Math.max(
      0,
      Number.isFinite(norms.sampleCount) ? norms.sampleCount : 0,
    );
    const hypothesis: ProjectionHypothesis = {
      id: `group:${chatId}`,
      kind: "group",
      subject: `chat:${chatId}`,
      statement: statements.join("；").slice(0, 420),
      source: `group_norms:${chatId}`,
      scopeKey: scopeKey({ visibility: "chat", chatId }),
      confidence: Math.min(0.9, 0.2 + sampleCount / (sampleCount + 20)),
      status: stale ? "stale" : "unverified",
      evidence: [`norms:${chatId}`],
      updatedAt,
      expiresAt,
    };
    return [hypothesis].slice(0, limit);
  } catch {
    uncertainties.push(`Group 投影暂时不可用（chat:${chatId}）。`);
    return [];
  }
}

function entityScope(entity: WorldEntity, chatId: number): string | null {
  const persisted = safeText(entity.scopeKey, 120);
  if (persisted && persisted !== "legacy") {
    if (persisted === "global" || persisted === `chat:${chatId}`)
      return persisted;
    return null;
  }
  if (entity.sourceChatId === null || entity.sourceChatId === undefined)
    return "global";
  return entity.sourceChatId === chatId ? `chat:${chatId}` : null;
}

function buildWorld(
  scope: CognitiveScope,
  limit: number,
  uncertainties: string[],
  asOf?: number,
): { hypotheses: ProjectionHypothesis[]; entities: WorldEntity[] } {
  if (!Number.isSafeInteger(scope.chatId) || scope.chatId === 0)
    return { hypotheses: [], entities: [] };
  const chatId = scope.chatId as number;
  try {
    const candidates = findEntities("", undefined, limit, scope, {
      ...(asOf === undefined ? {} : { asOf }),
    });
    const entities: WorldEntity[] = [];
    const hypotheses: ProjectionHypothesis[] = [];
    const now = asOf ?? nowSec();
    for (const currentEntity of candidates) {
      const name = safeText(currentEntity.name, 100);
      const kind = safeText(currentEntity.kind, 40);
      const scoped = entityScope(currentEntity, chatId);
      if (!name || !kind || !scoped) continue;
      let entity = currentEntity;
      if (asOf !== undefined && entity.lastUpdatedAt > asOf) {
        const revisionScope =
          scoped === "global"
            ? { visibility: "global" as const }
            : { visibility: "chat" as const, chatId };
        const revision = listEntityRevisions(
          entity.id,
          100,
          revisionScope,
        ).find((candidate) => candidate.createdAt <= asOf);
        if (revision) {
          entity = {
            ...entity,
            properties: revision.properties,
            lastUpdatedAt: revision.createdAt,
            currentRevision: revision.revision,
            sourceEventId: revision.sourceEventId,
            confidence: revision.confidence,
            expiresAt: revision.expiresAt,
          };
        } else {
          uncertainties.push(
            `实体 ${kind}:${name} 在事件锚点之后才有可见更新，已从历史投影中排除。`,
          );
          continue;
        }
      }
      if (entity.createdAt > now) continue;
      const properties = Object.entries(entity.properties ?? {})
        .slice(0, 8)
        .map(([key, value]) => `${safeText(key, 60)}=${safeText(value, 100)}`)
        .filter((value) => !value.startsWith("="));
      const updatedAt =
        Number.isSafeInteger(entity.lastUpdatedAt) && entity.lastUpdatedAt > 0
          ? entity.lastUpdatedAt
          : now;
      const expiresAt = entity.expiresAt ?? null;
      const stale = expiresAt !== null && expiresAt <= now;
      if (stale) {
        uncertainties.push(`实体状态可能已过期（${kind}:${name}）。`);
        continue;
      }
      entities.push(entity);
      hypotheses.push({
        id: `world:${entity.id}:r${entity.currentRevision ?? 0}`,
        kind: "world",
        subject: `${kind}:${name}`,
        statement:
          `${name}（${kind}）${properties.length ? `: ${properties.join(", ")}` : ""}`.slice(
            0,
            500,
          ),
        source: entity.sourceEventId
          ? `world_event:${entity.sourceEventId}`
          : `world_entities:${entity.id}`,
        scopeKey: scoped,
        confidence: clampConfidence(entity.confidence),
        status: "active",
        evidence: [entity.sourceEventId ?? `entity:${entity.id}`],
        updatedAt,
        expiresAt,
      });
    }
    return {
      hypotheses: hypotheses.slice(0, limit),
      entities: entities.slice(0, limit),
    };
  } catch {
    uncertainties.push(`World 投影暂时不可用（chat:${chatId}）。`);
    return { hypotheses: [], entities: [] };
  }
}

/** Build the read-only Self/Person/Group/World manifest for one scope. */
export function buildScopedWorldProjection(
  scope: CognitiveScope,
  budgetInput: WorldProjectionBudget = {},
): ScopedWorldProjection {
  const budget = normalizeBudget(budgetInput);
  const uncertainties: string[] = [];
  if (!validChatScope(scope)) {
    return {
      scope,
      self: buildSelf(budget.maxSelf, uncertainties, budget.asOf),
      person: [],
      group: [],
      world: [],
      worldEntities: [],
      uncertainties: [
        "工作区缺少有效 chat scope，已拒绝 Person/Group/World 投影。",
      ],
    };
  }
  const person = buildPerson(
    scope,
    budget.maxPerson,
    uncertainties,
    budget.asOf,
  );
  const group = buildGroup(scope, budget.maxGroup, uncertainties, budget.asOf);
  const world = buildWorld(scope, budget.maxWorld, uncertainties, budget.asOf);
  return {
    scope,
    self: buildSelf(budget.maxSelf, uncertainties, budget.asOf),
    person,
    group,
    world: world.hypotheses,
    worldEntities: world.entities,
    uncertainties: [...new Set(uncertainties)].slice(0, 20),
  };
}
