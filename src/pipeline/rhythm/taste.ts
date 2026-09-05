// ────────────────────────────────────────
// Taste — "觉得有意思"的确定性打分 (AGI H3.1)
// 真人转发前心里那杆秤:好笑/有用/有共鸣才转,广告/命令/口水不转。
// 纯本地 0ms,无 LLM。unified-tick 的 share 动作消费这个分。
// ────────────────────────────────────────

import { getDb } from "../../db/sqlite.js";
import { logger } from "../../shared/logger.js";
import type { FormattedMessage } from "../../shared/types.js";

/** 转发冷却:同一条 7 天内不重转 */
export const FORWARD_DEDUP_SEC = 7 * 86400;
/**
 * 分享阈值:分 ≥0.5 才值得转（H4.2 回放实证：9群×194条 human 消息，
 * 0.6 档 0 条、0.5 档 0 条、0.3-0.49 档 6 条全是真料——"官方群人怎么这么少"/
 * "我 turn 没改🤣"/"这个频道怎么这么多人..."。0.6 偏高饿死 share 动作，
 * 降到 0.5 让 funny/useful 单命中+meaty（0.45）够线、双命中（0.7）稳过）。
 */
export const SHARE_THRESHOLD = 0.5;

export interface TasteScore {
  score: number; // 0..1
  reasons: string[];
}

/** 噪音:进度条/纯符号/超短/媒体占位 */
const NOISE_RES = [
  /^\d+\.\d+%\s*\[\d+\/\d+\]$/,
  /^\[[= ]+\]$/,
  /^[\[\]=|—\-_.\d%\s/\\]+$/,
  /^\[?(?:表情|图片|贴纸|sticker|media|语音|视频)/i,
  /\[media\]/i,
  /\[source_id:\d+\]/,
];
/** 广告味:链接+钱/优惠/包月 */
const AD_RE = /https?:\/\/|包月|优惠|返利|邀请码|点击.*领取|19\.9|9\.9/;
const FUNNY_RE = /哈哈|笑死|绝了|典中典|绷不住|乐死|2333|🤣|😂|xswl|好活|神评/;
const USEFUL_RE = /教程|攻略|测速|避坑|干货|收藏|分享|教程|怎么|如何|解决|办法/;
const RESONANCE_RE = /破防|emo|扎心|真实|泪目|共鸣|说到心坎|太对了|truth|❤|🥺/;

export function scoreTaste(
  m: Pick<FormattedMessage, "role" | "textContent" | "captionContent" | "isBot">,
  opts: { reactions?: string[] } = {},
): TasteScore {
  const reasons: string[] = [];
  let score = 0;
  // bot 自己的话不转(回音室)
  if (m.role === "assistant" || m.isBot) return { score: 0, reasons: [] };
  const text = (m.textContent || m.captionContent || "").trim();
  if (text.length < 4 || text.length > 500) return { score: 0, reasons: [] };
  if (text.startsWith("/")) return { score: 0, reasons: [] };
  if (NOISE_RES.some((re) => re.test(text))) return { score: 0, reasons: [] };
  if (AD_RE.test(text)) return { score: 0, reasons: [] };

  if (FUNNY_RE.test(text)) { score += 0.35; reasons.push("funny"); }
  if (USEFUL_RE.test(text)) { score += 0.35; reasons.push("useful"); }
  if (RESONANCE_RE.test(text)) { score += 0.3; reasons.push("resonance"); }
  // reaction 是群众投票:3+ 个直接 +0.3
  const reacts = opts.reactions ?? [];
  if (reacts.length >= 3) { score += 0.3; reasons.push("crowd"); }
  else if (reacts.length >= 1) { score += 0.15; reasons.push("crowd1"); }
  // 有实质长度(>20 字)不是纯梗: +0.1
  if (text.length > 20 && score > 0) { score += 0.1; reasons.push("meaty"); }

  return { score: Math.min(1, Math.round(score * 100) / 100), reasons };
}

export function recordForward(chatId: number, messageId: number, score: number): void {
  try {
    getDb().prepare(
      `INSERT OR REPLACE INTO taste_forwards (from_chat_id, message_id, score) VALUES (?, ?, ?)`,
    ).run(chatId, messageId, score);
  } catch (err) {
    logger.warn({ err, chatId, messageId }, "recordForward failed");
  }
}

/** 这条 7 天内转过没(跨群共用去重,防两群互倒) */
export function wasForwardedRecently(chatId: number, messageId: number): boolean {
  try {
    const row = getDb().prepare(
      `SELECT 1 FROM taste_forwards WHERE from_chat_id = ? AND message_id = ?
       AND created_at > unixepoch() - ${FORWARD_DEDUP_SEC}`,
    ).get(chatId, messageId) as { 1?: number } | undefined;
    return !!row;
  } catch {
    return false; // 表不存在 → 没转过
  }
}

/** 该群 7 天内转过谁(给 share 动作排除用) */
export function getRecentForwards(chatId: number, limit = 20): number[] {
  try {
    const rows = getDb().prepare(
      `SELECT message_id FROM taste_forwards WHERE from_chat_id = ?
       AND created_at > unixepoch() - ${FORWARD_DEDUP_SEC}
       ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(50, limit))}`,
    ).all(chatId) as Array<{ message_id: number }>;
    return rows.map((r) => r.message_id);
  } catch {
    return [];
  }
}
