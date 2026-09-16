// ────────────────────────────────────────
// G13 反重复守卫 — 发送前的"我是不是刚说过这个"自检
// ────────────────────────────────────────
//
// MaiBot 的 difflib >0.9 重想守卫的移植:与自己最近 1-3 条消息做
// 字符 bigram Jaccard 相似度(无 LLM,CJK 友好),超阈值就带约束
// 重生成一次。专杀"bot 复读/换汤不换药"这个最经典的机器人信号。
// 现有 isDuplicateReply 只抓**完全一致**;这里抓"非常像"。

import { getRecent } from '../context/manager.js';
import { env } from '../../env.js';

function bigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/g, '').toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) {
    out.add(normalized.slice(i, i + 2));
  }
  return out;
}

/** Char-bigram Jaccard similarity in [0,1]. */
export function similarityRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (sa.size === 0 || sb.size === 0) {
    return a.replace(/\s+/g, '') === b.replace(/\s+/g, '') ? 1 : 0;
  }
  let inter = 0;
  for (const g of sa) {
    if (sb.has(g)) inter++;
  }
  return inter / (sa.size + sb.size - inter);
}

export interface NearDuplicateResult {
  isNearDuplicate: boolean;
  ratio: number;
  /** The prior bot message it collides with (for the regenerate constraint) */
  collidedWith?: string;
}

/**
 * Compare a candidate reply against the bot's last few sent messages.
 * Flag-gated by ANTI_REPEAT_ENABLED; short texts (<10 chars) are exempt
 * (短语句重复是正常口癖,不算复读).
 */
export async function checkNearDuplicate(chatId: number, candidate: string): Promise<NearDuplicateResult> {
  let threshold: number;
  try {
    const e = env();
    if (!e.ANTI_REPEAT_ENABLED) return { isNearDuplicate: false, ratio: 0 };
    threshold = e.ANTI_REPEAT_THRESHOLD;
  } catch {
    return { isNearDuplicate: false, ratio: 0 };
  }
  if (candidate.replace(/\s+/g, '').length < 10) return { isNearDuplicate: false, ratio: 0 };

  try {
    const recent = await getRecent(chatId, 40);
    const lastBotTexts = recent
      .filter((m) => m.role === 'assistant')
      .slice(-12)
      .map((m) => m.textContent)
      .filter((t) => t && t.length >= 10);

    let best = 0;
    let collided: string | undefined;
    for (const prior of lastBotTexts) {
      const ratio = similarityRatio(candidate, prior);
      if (ratio > best) {
        best = ratio;
        collided = prior;
      }
    }
    return { isNearDuplicate: best >= threshold, ratio: best, collidedWith: collided };
  } catch {
    return { isNearDuplicate: false, ratio: 0 };
  }
}
