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
/**
 * 跨群转发的入选分。
 *
 * 2026-09-21 一度想把它从 0.5 降到 0.45，因为实测 5 个群最近 109 条消息里
 * 没有一条够 0.5，`unified tick: shared` 上线以来 0 次。
 *
 * 但 0.5 是**有意的设计**（见 taste.test.ts 的 H4.2 那条）：单命中 + 有实质长度
 * 只有 0.45，放进来的话一句"哈哈哈"加长一点就能跨群转发，太松。
 * 要的是两个**互相独立**的信号（funny+useful = 0.7，或 funny+meaty+crowd = 0.75）。
 *
 * 而 0 次的真因不是线太高，是 `USEFUL_RE` 里原来含 `怎么|如何`——疑问词被当成
 * "有用"，于是"怎么那么多waifu""kddi怎么没解锁claude吗？"这类普通提问都拿到
 * 0.35。那一档虚高，让人以为线差一口气；把疑问词摘掉之后，剩下的 0.35 是真的
 * 短笑话，按设计就不该转。
 *
 * 这两个群近期的真实消息以指令和测速 bot 的刷屏为主，本来就没有值得跨群转的。
 * **"没触发"在这里是正确行为，不是故障。**
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
// 注意：这里原来含 `怎么|如何`——那是疑问词，不是"有用"的信号。
// 实测它把"怎么那么多waifu""kddi怎么没解锁claude吗？"这类普通提问也算成
// useful（+0.35），既污染了入选质量，也让 0.35 这一档虚高地常见。
// 2026-09-21 移除：有用的内容是"教程/攻略/避坑"这类名词，不是问句。
const USEFUL_RE = /教程|攻略|测速|避坑|干货|收藏|解决|办法|亲测|实测/;
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

export function recordForward(
  chatId: number,
  messageId: number,
  score: number,
  opts: { toChatId?: number; toMessageId?: number } = {},
): void {
  try {
    getDb().prepare(
      `INSERT OR REPLACE INTO taste_forwards
         (from_chat_id, message_id, score, to_chat_id, to_message_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(chatId, messageId, score, opts.toChatId ?? null, opts.toMessageId ?? null);
  } catch (err) {
    logger.warn({ err, chatId, messageId }, "recordForward failed");
  }
}

/**
 * 转发落地那条在目标群的新 messageId（taste 闭环归因用：目标群有人给
 * 转发点 reaction → reward 回给原话题。无记录返回 null）。
 */
export function getForwardLanding(fromChatId: number, messageId: number): {
  toChatId: number;
  toMessageId: number;
} | null {
  try {
    const row = getDb().prepare(
      `SELECT to_chat_id, to_message_id FROM taste_forwards
       WHERE from_chat_id = ? AND message_id = ?
       AND created_at > unixepoch() - ${FORWARD_DEDUP_SEC}`,
    ).get(fromChatId, messageId) as
      | { to_chat_id: number | null; to_message_id: number | null }
      | undefined;
    if (row && row.to_chat_id && row.to_message_id) {
      return { toChatId: row.to_chat_id, toMessageId: row.to_message_id };
    }
    return null;
  } catch {
    return null;
  }
}

/** 反查：目标群这条是转发的落点吗（是→返回源群+源 messageId）。 */
export function getForwardSource(toChatId: number, toMessageId: number): {
  fromChatId: number;
  messageId: number;
} | null {
  try {
    const row = getDb().prepare(
      `SELECT from_chat_id, message_id FROM taste_forwards
       WHERE to_chat_id = ? AND to_message_id = ?
       AND created_at > unixepoch() - ${FORWARD_DEDUP_SEC}`,
    ).get(toChatId, toMessageId) as
      | { from_chat_id: number; message_id: number }
      | undefined;
    if (row) return { fromChatId: row.from_chat_id, messageId: row.message_id };
    return null;
  } catch {
    return null;
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
