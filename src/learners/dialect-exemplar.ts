// ────────────────────────────────────────
// Dialect Exemplar — 群方言冷启动库 (AGI H2.1)
// Reif et al. 2022 style transfer recipe:新群人工挑 10 条"最有那味儿"
// 发言进 exemplar 库,只学风格不学内容,定期轮换防学到某人口头禅。
// 确定性挑选(0ms,无 LLM):去重 + 长度窗 + 去 bot/媒体/命令,首批 10 条。
// ────────────────────────────────────────

import { getDb } from "../db/sqlite.js";
import { logger } from "../shared/logger.js";

export const EXEMPLAR_MAX = 10;
/** exemplar TTL:90 天,过期由 learner-scan 轮换 */
export const EXEMPLAR_TTL_SEC = 90 * 86400;

/** bigram Jaccard(与 expression-learner 同源算法,阈值更严防近似重复) */
function jaccard(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const n = s.replace(/\s+/g, "").toLowerCase();
    const out = new Set<string>();
    for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2));
    return out;
  };
  const sa = grams(a);
  const sb = grams(b);
  if (sa.size === 0 || sb.size === 0) return a === b ? 1 : 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function isCandidate(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 2 || s.length > 60) return false;
  if (s.startsWith("SELF")) return false; // bot 自己的话
  if (s.startsWith("/")) return false; // 命令
  if (/^\[?(?:表情|图片|贴纸|sticker|media|语音|视频)/i.test(s)) return false;
  if (/^@\w+\s*$/.test(s)) return false; // 光 @ 人
  if (/https?:\/\//.test(s)) return false; // 链接
  return true;
}

/**
 * 从一批群聊文本里挑 ≤10 条 exemplar(确定性,无 LLM)。
 * 输入是已格式化的 "name: text" 行或纯文本;含 SELF 标记的行自动排除。
 */
export function pickExemplars(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    // 取冒号后的正文(learner-scan 格式 "name: text");无冒号整行当正文
    const m = line.match(/^(?:\[[^\]]+\]\s*)?([^:：]{1,24}[:：])\s*(.+)$/);
    const speaker = (m?.[1] ?? "").replace(/[:：]\s*$/, "").trim();
    // bot 自己的发言(SELF 标记)整行跳过 —— 不能只看正文
    if (/^self$/i.test(speaker)) continue;
    const text = (m?.[2] ?? line).trim();
    if (!isCandidate(line.trim()) && !isCandidate(text)) continue;
    const cand = isCandidate(text) ? text : line.trim();
    if (out.some((e) => jaccard(e, cand) > 0.7)) continue; // 近似重复
    out.push(cand);
    if (out.length >= EXEMPLAR_MAX) break;
  }
  return out;
}

export function saveExemplars(chatId: number, items: string[]): void {
  if (chatId >= 0 || items.length === 0) return; // DM 不建
  try {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO dialect_exemplars (chat_id, content) VALUES (?, ?)`,
    );
    const run = db.transaction((list: string[]) => {
      for (const c of list.slice(0, EXEMPLAR_MAX)) stmt.run(chatId, c.slice(0, 120));
    });
    run(items);
  } catch (err) {
    logger.warn({ err, chatId }, "saveExemplars failed");
  }
}

export function getExemplars(chatId: number): string[] {
  if (chatId >= 0) return [];
  try {
    const rows = getDb()
      .prepare(`SELECT content FROM dialect_exemplars WHERE chat_id = ? ORDER BY picked_at ASC LIMIT ${EXEMPLAR_MAX}`)
      .all(chatId) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  } catch {
    return []; // 表不存在 → 空
  }
}

/** 该群是否缺 exemplar(无记录;TTL 过期算缺,由调用方轮换) */
export function needsExemplars(chatId: number): boolean {
  if (chatId >= 0) return false;
  return getExemplars(chatId).length === 0;
}
