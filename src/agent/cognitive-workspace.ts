import { getDb } from '../db/sqlite.js';
import { getScratch } from '../tracking/scratchpad.js';
import { getContextEngine, type ContextPart } from '../context-engine/index.js';
import { logger } from '../shared/logger.js';
import { getActiveBeliefs } from '../core/beliefs/store.js';
import { findEntities, type WorldEntity } from './world-state.js';
import { listEntries } from '../core/blackboard/store.js';
import type { BeliefView } from '../core/beliefs/types.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';
import { getCognitiveEvent } from './cognitive-events.js';
import { buildScopedWorldProjection, type ProjectionHypothesis, type ScopedWorldProjection } from './world-projection.js';
import { buildSocialGraph, type SocialGraphSnapshot } from './social-event-graph.js';
import type { CognitiveDebt } from './cognitive-debts.js';

export interface CognitiveWorkspaceSemanticDebtOptions {
  /** Host-owned scorer; the workspace never chooses a model or makes an LLM call. */
  semanticScore: (input: { query: string; debt: CognitiveDebt }) => number | Promise<number>;
  /** Maximum scorer calls for this snapshot. The debt module applies a hard cap. */
  maxCandidates?: number;
  /** Minimum accepted score in [0, 1]. */
  minScore?: number;
}

export interface CognitiveWorkspaceScope {
  chatId: number;
  taskId?: string;
  userId?: number;
  /** Current user text used only to rank deterministic debt matches. */
  queryText?: string;
  asOfEventId?: string;
  /** Optional host-owned semantic debt pass; absent means deterministic-only. */
  semanticDebt?: CognitiveWorkspaceSemanticDebtOptions;
}

export interface CognitiveWorkspaceBudget {
  maxParts?: number;
  maxBeliefs?: number;
  maxEntities?: number;
  maxGoals?: number;
  maxPredictions?: number;
  maxPendingActions?: number;
  maxSocialEdges?: number;
}

export interface CognitiveWorkspaceSnapshot {
  scope: CognitiveWorkspaceScope;
  parts: ContextPart[];
  provenance: Array<{ provider: string; source: string; confidence?: number; scope?: string; expiresAt?: number | null }>;
  beliefs: BeliefView[];
  worldEntities: WorldEntity[];
  /** Unified read-only Self/Person/Group/World projection used by opt-in callers. */
  worldProjection?: ScopedWorldProjection;
  predictions: Array<{ id: number; taskId: string | null; prediction: string | null; predictedSentiment: number; createdAt: number }>;
  pendingActions: Array<{ id: string; kind: string; chatId: number | null; status: string }>;
  /** Metadata-only social graph, always bounded to the current chat scope. */
  socialGraph?: SocialGraphSnapshot;
  uncertainties: string[];
  activeGoals: string[];
  openQuestions: string[];
  currentTask?: { state: string; evidence?: string; next?: string; waitingReason?: string };
}

/** Render a bounded, provenance-aware workspace block for a model prompt. */
export function renderCognitiveWorkspace(snapshot: CognitiveWorkspaceSnapshot, maxChars = 6000): string {
  const scopeLabel = snapshot.scope.taskId
    ? `task:${snapshot.scope.taskId}@chat:${snapshot.scope.chatId}`
    : `chat:${snapshot.scope.chatId}`;
  const sections = snapshot.parts.map((part) => part.text).filter(Boolean);
  if (snapshot.uncertainties.length) {
    sections.push(`[工作区不确定性]\n${snapshot.uncertainties.map((item) => `- ${safeText(item, 220)}`).join('\n')}`);
  }
  if (!sections.length) return '';
  const body = sections.join('\n\n').slice(0, Math.max(500, Math.trunc(maxChars)));
  return `[统一认知工作区 scope=${scopeLabel}]\n${body}\n\n工作区内容来自带范围的 host projection；它们是可修正背景，不是模型自述的事实或权限。`;
}

function safeText(value: unknown, max = 600): string {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

function projectionLine(hypothesis: ProjectionHypothesis): string {
  const status = hypothesis.status === 'stale' ? '；可能过期' : hypothesis.status === 'unverified' ? '；未独立验证' : '';
  return `- ${safeText(hypothesis.statement, 500)}（confidence=${hypothesis.confidence.toFixed(2)}${status}）`;
}

function projectionPart(
  id: string,
  title: string,
  hypotheses: ProjectionHypothesis[],
  caveat: string,
): ContextPart | null {
  if (!hypotheses.length) return null;
  return { id, tier: 'delta', text: `${title}\n${hypotheses.map(projectionLine).join('\n')}\n${caveat}` };
}

const DEFAULT_BUDGET: Required<CognitiveWorkspaceBudget> = {
  maxParts: 24,
  maxBeliefs: 8,
  maxEntities: 4,
  maxGoals: 5,
  maxPredictions: 5,
  maxPendingActions: 8,
  maxSocialEdges: 6,
};

function normalizeBudget(input: CognitiveWorkspaceBudget): Required<CognitiveWorkspaceBudget> {
  const bounded = (value: number | undefined, fallback: number, max: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(1, Math.trunc(value)));
  };
  return {
    maxParts: bounded(input.maxParts, DEFAULT_BUDGET.maxParts, 100),
    maxBeliefs: bounded(input.maxBeliefs, DEFAULT_BUDGET.maxBeliefs, 50),
    maxEntities: bounded(input.maxEntities, DEFAULT_BUDGET.maxEntities, 50),
    maxGoals: bounded(input.maxGoals, DEFAULT_BUDGET.maxGoals, 50),
    maxPredictions: bounded(input.maxPredictions, DEFAULT_BUDGET.maxPredictions, 50),
    maxPendingActions: bounded(input.maxPendingActions, DEFAULT_BUDGET.maxPendingActions, 50),
    maxSocialEdges: bounded(input.maxSocialEdges, DEFAULT_BUDGET.maxSocialEdges, 30),
  };
}

/**
 * Build a small, scoped cognitive view from existing stores. This is a read-only
 * facade: it does not create a second memory database or bypass privacy filters.
 */
export async function buildCognitiveWorkspace(
  scope: CognitiveWorkspaceScope,
  budgetInput: CognitiveWorkspaceBudget = {},
): Promise<CognitiveWorkspaceSnapshot> {
  const budget = normalizeBudget(budgetInput);
  const parts: ContextPart[] = [];
  const provenance: CognitiveWorkspaceSnapshot['provenance'] = [];
  const beliefs: BeliefView[] = [];
  const worldEntities: WorldEntity[] = [];
  const predictions: CognitiveWorkspaceSnapshot['predictions'] = [];
  const pendingActions: CognitiveWorkspaceSnapshot['pendingActions'] = [];
  let socialGraph: SocialGraphSnapshot | undefined;
  const uncertainties: string[] = [];
  const activeGoals: string[] = [];
  const openQuestions: string[] = [];
  let currentTask: CognitiveWorkspaceSnapshot['currentTask'];

  const cognitiveScope: CognitiveScope = {
    visibility: 'task',
    chatId: scope.chatId,
    ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
    ...(scope.taskId ? { taskId: scope.taskId } : { taskId: `workspace:${scope.chatId}` }),
  };
  const scopeLabel = `chat:${scope.chatId}${scope.userId !== undefined ? `@user:${scope.userId}` : ''}`;
  let anchorOccurredAt: number | undefined;
  if (scope.asOfEventId) {
    const anchor = getCognitiveEvent(scope.asOfEventId);
    const anchorScopeMatches = anchor
      && anchor.chatId === scope.chatId
      && (!anchor.taskId || anchor.taskId === scope.taskId)
      && anchor.occurredAt <= Math.floor(Date.now() / 1000) + 60;
    if (anchor && anchorScopeMatches) {
      anchorOccurredAt = anchor.occurredAt;
      provenance.push({ provider: 'cognitive-events', source: `event:${anchor.id}`, scope: anchor.scopeKey });
    } else if (anchor) {
      uncertainties.push('工作区锚点事件与当前 scope 不一致，已拒绝历史投影。');
    } else {
      uncertainties.push('工作区锚点事件不存在，当前快照按实时状态组装。');
    }
  }
  let worldProjection: ScopedWorldProjection | undefined;
  try {
    worldProjection = buildScopedWorldProjection(cognitiveScope, {
      maxSelf: 3,
      maxPerson: scope.userId === undefined ? 0 : 1,
      maxGroup: 1,
      maxWorld: budget.maxEntities,
      ...(anchorOccurredAt === undefined ? {} : { asOf: anchorOccurredAt }),
    });
    uncertainties.push(...worldProjection.uncertainties);
    for (const hypothesis of [
      ...worldProjection.self,
      ...worldProjection.person,
      ...worldProjection.group,
      ...worldProjection.world,
    ]) {
      provenance.push({
        provider: `projection:${hypothesis.kind}`,
        source: hypothesis.source,
        scope: hypothesis.scopeKey,
        confidence: hypothesis.confidence,
        expiresAt: hypothesis.expiresAt,
      });
    }
  } catch (err) {
    logger.debug({ err, chatId: scope.chatId }, 'unified world projection failed (non-critical)');
  }

  try {
    const scratch = await getScratch(scope.chatId);
    if (scratch.length) {
      parts.push({
        id: 'workspace:scratch',
        tier: 'ephemeral',
        text: `[工作记忆]\n${scratch.map((x) => `- ${safeText(x.text, 140)}`).join('\n')}`,
      });
      provenance.push({ provider: 'scratchpad', source: `chat:${scope.chatId}` });
    }
  } catch (err) {
    logger.debug({ err, chatId: scope.chatId }, 'workspace scratch read failed');
  }

  // Core projections: all reads use the same task/chat/user scope. Invalid or
  // legacy rows are ignored rather than rendered as authoritative state.
  try {
    for (const predicate of ['group.norm', 'person.interest', 'person.trait']) {
      if (beliefs.length >= budget.maxBeliefs) break;
      const rows = getActiveBeliefs(predicate, {
        scope: cognitiveScope,
        ...(anchorOccurredAt === undefined ? {} : { now: anchorOccurredAt, asOf: anchorOccurredAt }),
      });
      for (const belief of rows) {
        if (beliefs.length >= budget.maxBeliefs || belief.effectiveStatus === 'contradicted') break;
        if (!belief.summary || !belief.scopeKey || belief.scopeKey === 'legacy') continue;
        beliefs.push(belief);
      }
    }
    if (beliefs.length) {
      parts.push({
        id: 'workspace:beliefs',
        tier: 'delta',
        text: `[有范围的当前信念]\n${beliefs.map((b) => `- (${b.predicate}; confidence=${b.decayedConfidence.toFixed(2)}) ${safeText(b.summary, 180)}`).join('\n')}\n以上信念带有当前聊天/用户范围和衰减置信度，只能作为可修正背景。`,
      });
      provenance.push({ provider: 'core-beliefs', source: scopeLabel, scope: scopeLabel });
    }
  } catch (err) {
    logger.debug({ err, chatId: scope.chatId }, 'workspace beliefs read failed');
  }

  if (worldProjection) {
    worldEntities.push(...worldProjection.worldEntities.slice(0, budget.maxEntities));
    const part = projectionPart('workspace:world', '[相关世界实体]', worldProjection.world, '实体状态带来源和有效期，优先以当前聊天和可验证结果为准。');
    if (part) parts.push(part);
  } else {
    try {
      const entities = findEntities('', undefined, budget.maxEntities, cognitiveScope, {
        ...(anchorOccurredAt === undefined ? {} : { asOf: anchorOccurredAt }),
      });
      for (const entity of entities) {
        if (typeof entity.name === 'string' && entity.name !== 'undefined') worldEntities.push(entity);
      }
      if (worldEntities.length) {
        parts.push({
          id: 'workspace:world',
          tier: 'delta',
          text: `[相关世界实体]\n${worldEntities.map((entity) => {
            const props = Object.entries(entity.properties).map(([key, value]) => `${key}=${safeText(value, 80)}`).join(', ');
            return `- ${entity.kind}「${safeText(entity.name, 100)}」: ${props || '(无属性)'}`;
          }).join('\n')}\n实体状态可能过时，优先以当前聊天和可验证结果为准。`,
        });
        provenance.push({ provider: 'world-entities', source: scopeLabel, scope: scopeLabel });
      }
    } catch (err) {
      logger.debug({ err, chatId: scope.chatId }, 'workspace world read failed');
    }
  }

  // The social graph is an opt-in workspace projection, not a policy input.
  // Keep it group-local and metadata-only so names, message bodies and
  // cross-chat identity guesses never enter the snapshot.
  if (scope.chatId < 0) {
    try {
      socialGraph = buildSocialGraph({
        chatId: scope.chatId,
        ...(scope.userId === undefined ? {} : { userId: scope.userId }),
        ...(scope.asOfEventId === undefined ? {} : { asOfEventId: scope.asOfEventId }),
        limit: Math.min(300, Math.max(30, budget.maxSocialEdges * 20)),
        maxEdges: budget.maxSocialEdges,
      });
      if (socialGraph.edges.length) {
        parts.push({
          id: 'workspace:social-graph',
          tier: 'delta',
          text:
            `[本群近期互动关系（仅 metadata）]\n` +
            socialGraph.edges.map((edge) =>
              `- uid:${edge.fromUid} -> uid:${edge.toUid} weight=${edge.weight.toFixed(2)} ` +
              `count=${edge.interactionCount} kinds=${edge.kinds.join(',')}`,
            ).join('\n') +
            `\n这是按互动事件衰减的可回放提示，不是永久关系、身份合并或发言许可。`,
        });
        provenance.push({ provider: 'social-event-graph', source: `chat:${scope.chatId}`, scope: `chat:${scope.chatId}` });
      }
    } catch (err) {
      logger.debug({ err, chatId: scope.chatId }, 'workspace social graph failed (non-critical)');
    }
  }

  if (worldProjection) {
    const personPart = projectionPart('workspace:target-user', '[当前用户画像]', worldProjection.person, '这是本群画像，不代表跨群或永久事实。');
    if (personPart) parts.push({ ...personPart, tier: 'ephemeral' });
    const groupPart = projectionPart('workspace:group', '[群体规范]', worldProjection.group, '群规范只作为可修正的风格假设，不覆盖当前消息和权限。');
    if (groupPart) parts.push(groupPart);
  }

  try {
    const db = getDb();
    const asOfClause = anchorOccurredAt === undefined ? '' : ' AND updated_at <= ?';
    const rows = db.prepare(
      `SELECT id, topic, chat_id, updated_at FROM goals
       WHERE status = 'active' AND (chat_id = ? OR chat_id IS NULL)${asOfClause}
       ORDER BY updated_at DESC LIMIT ?`,
    ).all(...(anchorOccurredAt === undefined
      ? [scope.chatId, budget.maxGoals]
      : [scope.chatId, anchorOccurredAt, budget.maxGoals])) as Array<{ id?: number; topic?: string; chat_id?: number | null; updated_at?: number }>;
    const goals = rows.map((row) => ({ topic: safeText(row.topic, 180), chatId: row.chat_id ?? null, updatedAt: row.updated_at ?? null })).filter((row) => row.topic);
    for (const goal of goals) if (!activeGoals.includes(goal.topic)) activeGoals.push(goal.topic);
    if (goals.length) {
      parts.push({ id: 'workspace:goals', tier: 'delta', text: `[当前关注目标]\n${goals.map((goal) => `- ${goal.topic}`).join('\n')}\n目标仍需后续证据确认，不把模型自述当完成。` });
      provenance.push({ provider: 'goals', source: scopeLabel, scope: scopeLabel });
    }
  } catch (err) {
    logger.debug({ err, chatId: scope.chatId }, 'workspace goals read failed');
  }

  try {
    const db = getDb();
    const predictionStatusClause = anchorOccurredAt === undefined
      ? 'actual_sentiment IS NULL'
      : '(actual_sentiment IS NULL OR resolved_at IS NULL OR resolved_at > ?)';
    const createdClause = anchorOccurredAt === undefined ? '' : ' AND created_at <= ?';
    const rows = db.prepare(
      `SELECT id, task_id, prediction, predicted_sentiment, created_at
       FROM bot_predictions
       WHERE chat_id = ? AND ${predictionStatusClause}${createdClause}
         AND (? IS NULL OR task_id = ?)
       ORDER BY created_at DESC LIMIT ?`,
    ).all(...(anchorOccurredAt === undefined
      ? [scope.chatId, scope.taskId ?? null, scope.taskId ?? null, budget.maxPredictions]
      : [scope.chatId, anchorOccurredAt, anchorOccurredAt, scope.taskId ?? null, scope.taskId ?? null, budget.maxPredictions])) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const prediction = {
        id: Number(row['id']),
        taskId: row['task_id'] === null ? null : String(row['task_id']),
        prediction: row['prediction'] === null ? null : safeText(row['prediction'], 180),
        predictedSentiment: Number(row['predicted_sentiment'] ?? 0.5),
        createdAt: Number(row['created_at']),
      };
      if (prediction.id > 0) predictions.push(prediction);
    }
    if (predictions.length) {
      parts.push({ id: 'workspace:predictions', tier: 'delta', text: `[尚未观察结果的预测]\n${predictions.map((prediction) => `- ${prediction.prediction ?? '未命名预测'} (sentiment=${prediction.predictedSentiment.toFixed(2)})`).join('\n')}\n没有实际反馈前不要据此提高信心或奖励技能。` });
      provenance.push({ provider: 'bot-predictions', source: scopeLabel, scope: scopeLabel });
    }
  } catch (err) {
    logger.debug({ err, chatId: scope.chatId }, 'workspace predictions read failed');
  }

  try {
    const entries = listEntries(
      'authorized_intent',
      'open',
      anchorOccurredAt === undefined ? budget.maxPendingActions : Math.min(200, budget.maxPendingActions * 4),
    ).filter((entry) => anchorOccurredAt === undefined || entry.updatedAt <= anchorOccurredAt).slice(0, budget.maxPendingActions);
    for (const entry of entries) {
      if (entry.chatId === scope.chatId) pendingActions.push({ id: entry.id, kind: entry.kind, chatId: entry.chatId, status: entry.status });
    }
    if (pendingActions.length) {
      parts.push({ id: 'workspace:pending-actions', tier: 'delta', text: `[待授权动作]\n${pendingActions.map((entry) => `- ${entry.id} (${entry.status})`).join('\n')}\n动作必须继续经过 host 权限和幂等检查。` });
      provenance.push({ provider: 'core-blackboard', source: scopeLabel, scope: scopeLabel });
    }
  } catch (err) {
    logger.debug({ err, chatId: scope.chatId }, 'workspace pending action read failed');
  }

  if (!worldProjection) {
    try {
      const db = getDb();
      const row = db.prepare(
        `SELECT profile_prompt FROM user_profiles WHERE chat_id = ? AND uid = ?${anchorOccurredAt === undefined ? '' : ' AND updated_at <= ?'}`,
      ).get(...(anchorOccurredAt === undefined
        ? [scope.chatId, scope.userId ?? 0]
        : [scope.chatId, scope.userId ?? 0, anchorOccurredAt])) as { profile_prompt?: string | null } | undefined;
      const profile = safeText(row?.profile_prompt, 260);
      if (profile) {
        parts.push({ id: 'workspace:target-user', tier: 'ephemeral', text: `[当前用户画像]\n${profile}\n这是本群画像，不代表跨群或永久事实。` });
        provenance.push({ provider: 'user-profile', source: `${scopeLabel}`, scope: scopeLabel });
      }
    } catch (err) {
      logger.debug({ err, chatId: scope.chatId, userId: scope.userId }, 'workspace target profile read failed');
    }
  }

  try {
    if (scope.taskId) {
      const { loadCodeActTask } = await import('../subagent/task-store.js');
      const task = await loadCodeActTask(scope.taskId);
      const taskCreatedAtSec = task ? Math.floor(Number(task.createdAt) / 1000) : 0;
      if (task && anchorOccurredAt !== undefined && taskCreatedAtSec > anchorOccurredAt) {
        uncertainties.push('CodeAct 任务在事件锚点之后创建，已从历史工作区排除。');
      } else if (task) {
        activeGoals.push(safeText(task.contentDirection, 240));
        currentTask = {
          state: task.waitingForUser ? 'waiting_user' : task.status,
          next: task.checkpointKey ? '可从 checkpoint 继续' : undefined,
          waitingReason: task.waitingReason,
        };
        provenance.push({ provider: 'codeact-task', source: `task:${scope.taskId}` });
        if (task.waitingForUser) openQuestions.push(task.waitingReason ?? '等待用户补充信息');
      }
    }
  } catch (err) {
    logger.debug({ err, taskId: scope.taskId }, 'workspace CodeAct task read failed');
  }

  if (!scope.taskId) {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT goal, state, result, progress FROM tasks
         WHERE chat_id = ? AND state IN ('pending','running','blocked','waiting_user')
         ${anchorOccurredAt === undefined ? '' : 'AND updated_at <= ?'}
         ORDER BY updated_at DESC LIMIT 3`,
      ).all(...(anchorOccurredAt === undefined ? [scope.chatId] : [scope.chatId, anchorOccurredAt])) as Array<{ goal?: string; state?: string; result?: string; progress?: string }>;
      for (const row of rows) {
        const goal = safeText(row.goal, 180);
        if (!goal) continue;
        activeGoals.push(goal);
        const progress = safeText(row.progress, 300);
        currentTask ??= { state: safeText(row.state, 40), next: progress || undefined };
      }
      if (rows.length) provenance.push({ provider: 'task-store', source: `chat:${scope.chatId}` });
    } catch (err) {
      logger.debug({ err, chatId: scope.chatId }, 'workspace task read failed');
    }
  }

  if (scope.taskId) {
    try {
      const row = getDb().prepare(
        `SELECT assessment, reasons FROM task_evidence WHERE task_id = ?${anchorOccurredAt === undefined ? '' : ' AND updated_at <= ?'} LIMIT 1`,
      ).get(...(anchorOccurredAt === undefined ? [scope.taskId] : [scope.taskId, anchorOccurredAt])) as { assessment?: string; reasons?: string } | undefined;
      if (row) {
        currentTask = {
          ...(currentTask ?? { state: 'running' }),
          evidence: safeText(row.assessment, 80),
        };
        if (row.assessment && row.assessment !== 'verified') {
          uncertainties.push('当前任务结果尚未通过外部验收，不能把模型声称的完成当成已确认事实。');
        }
        provenance.push({ provider: 'task-evidence', source: `task:${scope.taskId}`, confidence: row.assessment === 'verified' ? 1 : 0.4 });
      } else if (anchorOccurredAt !== undefined) {
        uncertainties.push('事件锚点之前没有可用的 task evidence，验收状态未知。');
      }
    } catch (err) {
      logger.debug({ err, taskId: scope.taskId }, 'workspace evidence read failed');
    }
  }

  try {
    const {
      listOpenDebtsScoped,
      findRelatedDebtsScoped,
      findRelatedDebtsScopedWithSemantic,
    } = await import('./cognitive-debts.js');
    const listedDebts = listOpenDebtsScoped(cognitiveScope, 5, anchorOccurredAt === undefined ? {} : { asOf: anchorOccurredAt });
    const query = scope.queryText?.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 800) ?? '';
    let debtProvider = query ? 'cognitive-debts:deterministic-matcher' : 'cognitive-debts';
    let matches: Array<{ debt: CognitiveDebt }> = [];
    if (query && typeof findRelatedDebtsScoped === 'function') {
      try {
        matches = findRelatedDebtsScoped(cognitiveScope, query, {
          limit: 5,
          maxCandidates: 100,
          ...(anchorOccurredAt === undefined ? {} : { asOf: anchorOccurredAt }),
        });
      } catch (err) {
        logger.debug({ err, chatId: scope.chatId }, 'workspace deterministic debt matcher failed');
      }
    }
    if (
      query &&
      scope.semanticDebt &&
      typeof scope.semanticDebt.semanticScore === 'function' &&
      typeof findRelatedDebtsScopedWithSemantic === 'function'
    ) {
      try {
        const semanticMatches = await findRelatedDebtsScopedWithSemantic(cognitiveScope, query, {
          limit: 5,
          maxCandidates: 100,
          maxSemanticCandidates: scope.semanticDebt.maxCandidates,
          minSemanticScore: scope.semanticDebt.minScore,
          semanticScore: scope.semanticDebt.semanticScore,
          ...(anchorOccurredAt === undefined ? {} : { asOf: anchorOccurredAt }),
        });
        if (semanticMatches.length) {
          matches = semanticMatches;
          debtProvider = 'cognitive-debts:semantic-matcher';
        }
      } catch (err) {
        // Semantic matching is an optional enrichment. Keep deterministic
        // matches and the normal priority list when the host scorer fails.
        logger.debug({ err, chatId: scope.chatId }, 'workspace semantic debt matcher failed');
      }
    }
    const debts = (() => {
      if (!matches.length) return listedDebts;
      const ordered = new Map<number, (typeof listedDebts)[number]>();
      for (const match of matches) ordered.set(match.debt.id, match.debt);
      for (const debt of listedDebts) ordered.set(debt.id, debt);
      return [...ordered.values()].slice(0, 5);
    })();
    if (debts.length) {
      parts.push({
        id: 'workspace:debts',
        tier: 'delta',
        text:
          `[未完成的认知债务]\n` +
          debts.map((d) => `- (${d.kind}) ${d.statement}`).join('\n') +
          `\n这些是你自己欠着的事：相关消息出现时优先偿还（兑现/核实/承认/修正），无关就当背景，别硬提。`,
      });
      provenance.push({
        provider: debtProvider,
        source: `chat:${scope.chatId}`,
        confidence: debtProvider.endsWith('semantic-matcher') ? 0.75 : 0.8,
      });
      for (const d of debts.slice(0, 3)) openQuestions.push(d.statement);
    }
    if (anchorOccurredAt !== undefined && debts.some((debt) => debt.historyLegacy)) {
      uncertainties.push('迁移前的认知债务只有当前 legacy 快照，事件锚点无法推断其更早状态。');
    }
  } catch (err) {
    logger.debug({ err, chatId: scope.chatId }, 'workspace debts read failed');
  }

  if (worldProjection) {
    const selfPart = projectionPart('workspace:self', '[对自己的认知]', worldProjection.self, '这些是带证据的行为假设，自然遵守即可，别把笔记本身当成事实。');
    if (selfPart) parts.push({ ...selfPart, tier: 'ephemeral' });
  } else {
    try {
      const { getActiveSelfNotes } = await import('../tracking/self-model.js');
      const notes = getActiveSelfNotes(2, anchorOccurredAt);
      if (notes.length) {
        parts.push({
          id: 'workspace:self',
          tier: 'ephemeral',
          text:
            `[对自己的认知]\n` +
            notes.map((n) => `- ${String(n.note).slice(0, 120)}`).join('\n') +
            `\n这些是你复盘自己得出的行为认知，自然遵守即可，别提起它们的存在。`,
        });
        provenance.push({ provider: 'self-model', source: 'self_model_notes', confidence: 0.5 });
      }
    } catch (err) {
      logger.debug({ err }, 'workspace self-model read failed');
    }
  }

  const engine = getContextEngine(`workspace:${scope.chatId}`);
  const boundedParts = parts.slice(0, budget.maxParts);
  const rendered = await engine.assemble(boundedParts.map((part) => ({
    id: part.id,
    tier: part.tier,
    provide: () => part,
  })));
  return {
    scope,
    parts: boundedParts.filter((part) => rendered.prompt.includes(part.text)),
    beliefs,
    worldEntities,
    predictions,
    pendingActions,
    socialGraph,
    worldProjection,
    provenance,
    uncertainties,
    activeGoals,
    openQuestions,
    currentTask,
  };
}
