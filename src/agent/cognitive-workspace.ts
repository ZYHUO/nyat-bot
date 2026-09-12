import { getDb } from '../db/sqlite.js';
import { getScratch } from '../tracking/scratchpad.js';
import { getContextEngine, type ContextPart } from '../context-engine/index.js';
import { logger } from '../shared/logger.js';

export interface CognitiveWorkspaceScope {
  chatId: number;
  taskId?: string;
  userId?: number;
}

export interface CognitiveWorkspaceSnapshot {
  scope: CognitiveWorkspaceScope;
  parts: ContextPart[];
  provenance: Array<{ provider: string; source: string; confidence?: number }>;
  uncertainties: string[];
  activeGoals: string[];
  openQuestions: string[];
  currentTask?: { state: string; evidence?: string; next?: string; waitingReason?: string };
}

function safeText(value: unknown, max = 600): string {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
}

/**
 * Build a small, scoped cognitive view from existing stores. This is a read-only
 * facade: it does not create a second memory database or bypass privacy filters.
 */
export async function buildCognitiveWorkspace(scope: CognitiveWorkspaceScope): Promise<CognitiveWorkspaceSnapshot> {
  const parts: ContextPart[] = [];
  const provenance: CognitiveWorkspaceSnapshot['provenance'] = [];
  const uncertainties: string[] = [];
  const activeGoals: string[] = [];
  const openQuestions: string[] = [];
  let currentTask: CognitiveWorkspaceSnapshot['currentTask'];

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

  try {
    if (scope.taskId) {
      const { loadCodeActTask } = await import('../subagent/task-store.js');
      const task = await loadCodeActTask(scope.taskId);
      if (task) {
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
         ORDER BY updated_at DESC LIMIT 3`,
      ).all(scope.chatId) as Array<{ goal?: string; state?: string; result?: string; progress?: string }>;
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
        `SELECT assessment, reasons FROM task_evidence WHERE task_id = ? LIMIT 1`,
      ).get(scope.taskId) as { assessment?: string; reasons?: string } | undefined;
      if (row) {
        currentTask = {
          ...(currentTask ?? { state: 'running' }),
          evidence: safeText(row.assessment, 80),
        };
        if (row.assessment && row.assessment !== 'verified') {
          uncertainties.push('当前任务结果尚未通过外部验收，不能把模型声称的完成当成已确认事实。');
        }
        provenance.push({ provider: 'task-evidence', source: `task:${scope.taskId}`, confidence: row.assessment === 'verified' ? 1 : 0.4 });
      }
    } catch (err) {
      logger.debug({ err, taskId: scope.taskId }, 'workspace evidence read failed');
    }
  }

  try {
    const { listOpenDebts } = await import('./cognitive-debts.js');
    const debts = listOpenDebts(scope.chatId, 5);
    if (debts.length) {
      parts.push({
        id: 'workspace:debts',
        tier: 'delta',
        text:
          `[未完成的认知债务]\n` +
          debts.map((d) => `- (${d.kind}) ${d.statement}`).join('\n') +
          `\n这些是你自己欠着的事：相关消息出现时优先偿还（兑现/核实/承认/修正），无关就当背景，别硬提。`,
      });
      provenance.push({ provider: 'cognitive-debts', source: `chat:${scope.chatId}`, confidence: 0.8 });
      for (const d of debts.slice(0, 3)) openQuestions.push(d.statement);
    }
  } catch (err) {
    logger.debug({ err, chatId: scope.chatId }, 'workspace debts read failed');
  }

  try {
    const { getActiveSelfNotes } = await import('../tracking/self-model.js');
    const notes = getActiveSelfNotes(2);
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

  const engine = getContextEngine(`workspace:${scope.chatId}`);
  const rendered = await engine.assemble(parts.map((part) => ({
    id: part.id,
    tier: part.tier,
    provide: () => part,
  })));
  return {
    scope,
    parts: parts.filter((part) => rendered.prompt.includes(part.text)),
    provenance,
    uncertainties,
    activeGoals,
    openQuestions,
    currentTask,
  };
}
