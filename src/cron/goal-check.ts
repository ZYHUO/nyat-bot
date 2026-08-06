// ────────────────────────────────────────
// Goal Check — 周期性推进持续关注的目标 (AGI Level 4 P4-B)
//
// 每个到期 goal dispatch 一个 CodeAct 任务去「查一下进展」：
// web.search / 翻最近聊天 → 有新发现 sendText 简短汇报（走 proactive
// slot 防刷屏）→ episode distiller 复盘时把 finding 回写 goal。
// 没有新发现就安静 endTask —— 关注不等于刷屏。
// ────────────────────────────────────────

import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { isAsleep } from '../tracking/sleep.js';
import { listDueGoals } from '../agent/goals.js';
import { enqueueCodeActJob } from '../subagent/queue.js';

export async function runGoalCheck(): Promise<void> {
  if (!env().GOAL_TRACKER_ENABLED) return;
  try {
    if (await isAsleep()) return;

    const due = listDueGoals();
    if (!due.length) return;

    for (const goal of due) {
      const task = {
        id: `goal_${goal.id}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
        chatId: goal.chat_id ?? 0,
        contentDirection:
          `[goal:${goal.id}] 持续关注：「${goal.topic}」。` +
          `用 web.search 搜一下最新进展，或翻看最近聊天里有没有相关话题。` +
          (goal.last_finding ? `上次发现：${goal.last_finding}——看看有没有新进展。` : `这是第一次检查。`) +
          `有新发现就 sendText 简短汇报（像朋友分享"对了那个事有新消息"），没有就什么都不说直接 runtime.endTask。` +
          `最后必须 runtime.endTask("found: …" 或 "no_update") —— endTask 摘要里写清楚有没有新发现。`,
        toneGuidance: '自然分享，不像新闻播报',
        createdAt: Date.now(),
        status: 'queued' as const,
      };
      await enqueueCodeActJob(task);
      logger.info({ goalId: goal.id, topic: goal.topic.slice(0, 60) }, 'goal check dispatched');
    }
  } catch (err) {
    logger.warn({ err }, 'runGoalCheck failed');
  }
}
