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
  if (s.length < 4 || s.length > 60) return false; // 太短的全是噪音("冲!""嗯")
  // 注意:调用方已剥 [source_id:N] 前缀并取正文,这里只判干净正文。
  // 残留检查保留当保险(防未来调用方又传格式化行)。
  if (s.startsWith("SELF")) return false; // bot 自己的话
  if (s.startsWith("/")) return false; // 命令
  if (/^@\w+(\s+\d+[hm])?$/.test(s)) return false; // 光 @ 人 / 定时器残留(@every 1h)
  if (/^[⏳▸⚙🔍⌛✅❌⚠＃#@]/.test(s)) return false; // bot 状态行(进度/报告/后端/连通性)
  if (/^(连通性|速度)测试|检测报告|后端[:：]|当前进度|请选择|CRON-/i.test(s)) return false; // bot 状态正文
  if (/^\[文件[「\[]/.test(s)) return false; // 系统文件占位([文件「xxx」:…无法解析内容])
  if (/[ℭ℃]/.test(s)) return false; // 天气 bot 广播残留
  if (/^\[?(?:表情|图片|贴纸|sticker|media|语音|视频)/i.test(s)) return false;
  if (/^@\w+\s*$/.test(s)) return false; // 光 @ 人
  if (/https?:\/\//.test(s)) return false; // 链接
  if (/\[source_id:\d+\]/.test(s)) return false; // learner 格式化残留
  if (/\[media\]/i.test(s)) return false; // 媒体占位(无论冒号切分前后)
  if (/^\[[= ]+\]$/.test(s)) return false; // 进度条
  if (/^\d+\.\d+%\s*\[\d+\/\d+\]$/.test(s)) return false; // 下载进度行
  if (/^[\[\]=|—\-_.\d%\s\/\\]+$/.test(s)) return false; // 纯符号/数字行
  if (/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\s]+$/u.test(s)) return false; // 纯 emoji 行
  return true;
}

/**
 * 从一批群聊文本里挑 ≤10 条 exemplar(确定性,无 LLM)。
 * 输入是已格式化的 "name: text" 行或纯文本;含 SELF 标记的行自动排除。
 * H2 修复:输入可能是 learner-scan 格式 "[source_id:123] name: text" ——
 * 先剥 [source_id:N] 前缀,再走 speaker/正文切分。存库只存干净正文,
 * 不带 source_id/speaker 前缀(线上 10 条全是格式化残留的教训)。
 */
export function pickExemplars(lines: string[]): string[] {
  const out: string[] = [];
  for (const rawLine of lines) {
    // 先剥 learner 格式化前缀 "[source_id:123] "(精确匹配,不误伤正文里的方括号)
    const line = rawLine.replace(/^\[source_id:\d+\]\s*/, "");
    // H2 修2:行内换行只取首行 —— 多行 bot 报告(检测报告/后端列表)的后续行
    // ("> 疑似掉线"/"- xxx.com")不能当独立 exemplar。注意 learner 行本身
    // text.slice(0,200) 保留换行,所以这里必须按 \n 切。
    const firstLine = line.split("\n")[0]!.trim();
    if (line.trim() !== firstLine) continue; // 含换行 = 报告体/长文,整行不要
    // 取冒号后的正文(learner-scan 格式 "name: text");无冒号整行当正文
    const m = line.match(/^(?:\[[^\]]+\]\s*)?([^:：]{1,24}[:：])\s*(.+)$/);
    const speaker = (m?.[1] ?? "").replace(/[:：]\s*$/, "").trim();
    // bot 自己的发言(SELF 标记)整行跳过 —— 不能只看正文
    if (/^self$/i.test(speaker)) continue;
    // bot 状态行的 speaker 本身就是状态词(⚙️后端/⏳连通性/🔍检测)——整行扔,不看正文
    if (/^[⏳▸⚙🔍⌛✅❌⚠＃#@]/.test(speaker)) continue;
    if (/^(连通性|速度)测试|检测报告|后端|当前进度|请选择|CRON-/i.test(speaker)) continue;
    const text = (m?.[2] ?? line).trim();
    if (!isCandidate(text)) continue;
    if (out.some((e) => jaccard(e, text) > 0.7)) continue; // 近似重复
    out.push(text);
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
