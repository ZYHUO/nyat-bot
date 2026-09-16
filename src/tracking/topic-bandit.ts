// ────────────────────────────────────────
// Topic Bandit — 话题偏好 ε-greedy (H4, 确定性, 0ms, 无 LLM)
// ────────────────────────────────────────
//
// plan 原文: reaction=无监督 reward(👍❤️😂正/👎💩负/被 quote 追问=强正),
// 存 (bot发言→24h reaction向量) 做 bandit。
//
// 落地(最小闭环):
//   - recordPull(chatId, label): bot 跟进某话题 → pulls++
//   - recordReward(chatId, label, r): 反馈折成 reward 累加
//     (reaction sentiment [-1,1] / reply sentiment / 被 quote 追问 +1)
//   - pickTopic(chatId, candidates, eps): ε-greedy 选话题
//     未试过的优先探索; 全试过按平均 reward exploit; 负分自然被避开。
//
// 约束: 仅群聊(chatId<0); 空候选 → null; 确定性(ε=0 时纯 exploit)。

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

export interface TopicScore {
  chat_id: number;
  label: string;
  pulls: number;
  reward: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** bot 跟进某话题一次（发了相关回复就算一次 pull）。 */
export function recordPull(chatId: number, label: string): void {
  if (chatId > 0) return;
  const l = label.trim().slice(0, 40);
  if (!l) return;
  try {
    getDb().prepare(
      `INSERT INTO topic_scores (chat_id, label, pulls, reward, updated_at)
       VALUES (?, ?, 1, 0, ?)
       ON CONFLICT(chat_id, label) DO UPDATE SET
         pulls = pulls + 1, updated_at = excluded.updated_at`,
    ).run(chatId, l, nowSec());
  } catch (err) {
    logger.debug({ err, chatId }, 'recordPull failed (non-critical)');
  }
}

/** 反馈折成 reward（正/负都可，调用方已归一到 [-1, +1] 量级）。 */
export function recordReward(chatId: number, label: string, r: number): void {
  if (chatId > 0) return;
  const l = label.trim().slice(0, 40);
  if (!l || !Number.isFinite(r)) return;
  try {
    getDb().prepare(
      `INSERT INTO topic_scores (chat_id, label, pulls, reward, updated_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(chat_id, label) DO UPDATE SET
         reward = reward + excluded.reward, updated_at = excluded.updated_at`,
    ).run(chatId, l, r, nowSec());
  } catch (err) {
    logger.debug({ err, chatId }, 'recordReward failed (non-critical)');
  }
}

/** 本群全部话题分数（reward 降序）。 */
export function getTopicScores(chatId: number): TopicScore[] {
  try {
    return getDb().prepare(
      `SELECT chat_id, label, pulls, reward FROM topic_scores WHERE chat_id=? ORDER BY reward DESC`,
    ).all(chatId) as TopicScore[];
  } catch {
    return [];
  }
}

/**
 * ε-greedy 选话题。
 * @param eps 探索率（默认 0.2）。测试用 0（纯 exploit，确定性）。
 */
export function pickTopic(chatId: number, candidates: string[], eps = 0.2): string | null {
  if (chatId > 0 || candidates.length === 0) return null;
  try {
    const rows = getDb().prepare(
      `SELECT label, pulls, reward FROM topic_scores WHERE chat_id=?`,
    ).all(chatId) as Array<{ label: string; pulls: number; reward: number }>;
    const byLabel = new Map(rows.map((r) => [r.label, r]));
    // 探索：没试过的优先（pulls=0）
    const unseen = candidates.filter((c) => !(byLabel.get(c)?.pulls));
    if (unseen.length > 0) {
      if (Math.random() < eps || eps === 0) return unseen[0]!;
      // eps>0 但这次掷骰子没中探索 → 继续 exploit（全见过一样处理）
    }
    // Exploit：平均 reward 最高；都没分数时按原序第一个
    let best: string | null = null;
    let bestMean = -Infinity;
    for (const c of candidates) {
      const r = byLabel.get(c);
      const mean = r && r.pulls > 0 ? r.reward / r.pulls : 0;
      if (mean > bestMean) { bestMean = mean; best = c; }
    }
    return best;
  } catch {
    return candidates[0] ?? null;
  }
}
