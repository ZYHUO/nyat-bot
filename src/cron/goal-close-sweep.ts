// ────────────────────────────────────────
// Goal 待关闭观察期的结算
// ────────────────────────────────────────
//
// 模型在 goal 检查里说「已完成」，但证据门（task.assessment==='verified'）过不去——goal 检查任务
// 多半不发消息，没有 Echo 可观测。放宽证据门就是让模型自己给自己判完成；不放宽，goal 就永远
// active、占着 GOAL_MAX_ACTIVE（日志里 54 次 `goal rejected: max active reached`）。
//
// 两段式：executor 把「声称完成」的 goal 置为 pending_close（goals.requestGoalClose），这里在观察期满后
// 看世界的反应——观察期内该 goal 所在的聊天里，有没有**人**又提起这个话题：
//   · 有 → 说明事情没真了结（或又起了波澜）→ 回 active，goal 继续被跟进
//   · 没有 → 沉默即认可 → achieved（last_evidence='silence'，silence_closures++，
//            与 verified_achievements 分开记账，不把「没人再提」冒充成「被独立验证」）
//
// 局限，写在这里让下一个人别把它读成"理解"：
//   · 判据是字符 bigram 重叠（goals.mentionsGoalTopic），不是语义；
//   · 读不到观察期内的消息（群安静、Redis 窗口已滚过去）时按「没有人提」处理，
//     所以安静的群会更容易关闭——这是有意的：一个没人讨论的事项不该占着名额；
//   · 没有 chat_id 的 goal（主人 DM 之外无归属）读不到消息，保持 pending_close 不动，
//     等观察期 ×3 后按 stale 收掉，不凭空判定。

import { env } from '../env.js';
import { logger } from '../shared/logger.js';

export interface GoalCloseSweepResult {
  checked: number;
  closed: number;
  reopened: number;
  held: number;
  staled: number;
}

export async function runGoalCloseSweep(nowSec = Math.floor(Date.now() / 1000)): Promise<GoalCloseSweepResult> {
  const result: GoalCloseSweepResult = { checked: 0, closed: 0, reopened: 0, held: 0, staled: 0 };
  const observeSec = env().GOAL_CLOSE_OBSERVE_HOURS * 3600;
  try {
    const { listGoals, setGoalStatus, goalTopicGrams, mentionsGoalTopic } = await import('../agent/goals.js');
    const { getDb } = await import('../db/sqlite.js');
    const { getRecent } = await import('../pipeline/context/manager.js');
    const pending = listGoals('pending_close');
    for (const g of pending) {
      const since = g.close_requested_at ?? 0;
      if (!since) continue; // 没有起点的不处理——不能凭空算观察期
      if (nowSec - since < observeSec) continue; // 观察期没满
      result.checked++;

      if (g.chat_id === null || g.chat_id === undefined) {
        // 读不到消息：不下结论。放太久（×3）就按 stale 收掉，保证不永远占着。
        if (nowSec - since >= observeSec * 3) {
          setGoalStatus(g.id, 'stale');
          result.staled++;
        } else {
          result.held++;
        }
        continue;
      }

      let reMentioned = false;
      try {
        const grams = goalTopicGrams(g.topic);
        const recent = await getRecent(g.chat_id, 200);
        for (const m of recent) {
          if (m.role !== 'user' || m.timestamp < since) continue;
          const text = `${m.textContent ?? ''} ${m.captionContent ?? ''}`;
          if (mentionsGoalTopic(text, grams)) { reMentioned = true; break; }
        }
      } catch (err) {
        // 读失败 ≠ 没人提。不关、不开，留给下一轮。
        logger.debug({ err, goalId: g.id }, 'goal-close-sweep: recent read failed, holding');
        result.held++;
        continue;
      }

      if (reMentioned) {
        // 回 active，并清掉起点——下次再声称完成会重新计观察期。
        getDb().prepare(
          `UPDATE goals SET status = 'active', close_requested_at = NULL, updated_at = ? WHERE id = ? AND status = 'pending_close'`,
        ).run(nowSec, g.id);
        result.reopened++;
        logger.info({ goalId: g.id, topic: g.topic.slice(0, 40) }, 'goal reopened: topic mentioned again during close observation');
      } else {
        getDb().prepare(
          `UPDATE goals SET status = 'achieved', last_evidence = 'silence', silence_closures = silence_closures + 1,
             updated_at = ? WHERE id = ? AND status = 'pending_close'`,
        ).run(nowSec, g.id);
        result.closed++;
        logger.info({ goalId: g.id, topic: g.topic.slice(0, 40) }, 'goal closed by silence: no one raised it during observation');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'goal-close-sweep failed');
  }
  if (result.checked > 0) logger.info(result, 'goal-close-sweep ran');
  return result;
}
