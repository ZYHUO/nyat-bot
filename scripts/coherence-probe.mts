/**
 * round 207: **「前言不搭后语」的第一个免费数字。**
 *
 * Round 198 立的：用户那句「有点前言不搭后语」在这个 goal 里从没被量化过，
 * 因为它要 LLM 判断、没有确定性信号。
 *
 * Round 204/205/206 铺好了路：`host sendText` 现在可以带全文（SEND_LOG_FULL_TEXT）。
 * 这个脚本**只读日志**，不需要那个 flag 开着也能跑（只是没有 text 字段时跳过）。
 *
 * 判据（单边，round 204 立的）：
 *   对每条 bot 回复，算它与**前 N 条人话**的 bigram 重合数。
 *   0 重合 = 可能真的不搭（能证伪"完全无关"）
 *   >0 重合 = 开头接上了（但不能证明后面也接上）
 *
 * **只报分布，不报好坏**（round 186：leaning 向"没问题"要配第二数字，
 * 而这里连第一数字都没有，所以先量）。
 *
 * 用法：npx tsx scripts/coherence-probe.mts [天数]
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

const DAYS = Number(process.argv[2] ?? '3');
const LOOKBACK = 5;              // 前 5 条人话
const sinceMs = Date.now() - DAYS * 86_400_000;

/** 取一段文字的所有中文 bigram（两字组）。 */
const bigrams = (s: string): Set<string> => {
  const clean = s.replace(/[\s\p{P}\p{S}]/gu, '');
  const out = new Set<string>();
  for (let i = 0; i + 1 < clean.length; i++) out.add(clean.slice(i, i + 2));
  return out;
};

interface Row { t: number; from: 'bot' | 'human'; text: string; chatId: string }

const rows: Row[] = [];
for (const line of execSync('cat logs/app.log', { encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n')) {
  if (!line.trim()) continue;
  let d: Record<string, unknown>;
  try { d = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
  const t = Number(d.time ?? 0);
  if (t < sinceMs) continue;
  const chatId = String(d.chatId ?? '');
  const msg = String(d.msg ?? '');
  if (msg === 'host sendText' && d.taskId) {
    const text = typeof d.text === 'string' ? d.text : String(d.preview ?? '');
    if (text.trim()) rows.push({ t, from: 'bot', text, chatId });
  } else if (msg === 'message in') {
    const text = typeof d.text === 'string' ? d.text
      : (typeof d.preview === 'string' ? d.preview : '');
    if (text.trim()) rows.push({ t, from: 'human', text, chatId });
  }
}
rows.sort((a, b) => a.t - b.t);

let withFullText = 0;
const hits: number[] = [];
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]!;
  if (r.from !== 'bot') continue;
  const recent = rows.slice(Math.max(0, i - LOOKBACK), i).filter((x) => x.from === 'human' && x.chatId === r.chatId);
  if (recent.length === 0) continue;
  const rb = bigrams(r.text);
  if (rb.size === 0) continue;
  let n = 0;
  for (const h of recent) for (const b of bigrams(h.text)) if (rb.has(b)) n++;
  hits.push(n);
}

if (hits.length === 0) {
  console.log(`窗口 ${DAYS} 天内没有可算的 bot 回复（需要 host sendText 带 text 字段 —— 开 SEND_LOG_FULL_TEXT）`);
  process.exit(0);
}

const zero = hits.filter((h) => h === 0).length;
const dist: Record<string, number> = {};
for (const h of hits) {
  const bucket = h === 0 ? '0' : h <= 2 ? '1-2' : h <= 5 ? '3-5' : h <= 10 ? '6-10' : '11+';
  dist[bucket] = (dist[bucket] ?? 0) + 1;
}
console.log(`窗口 ${DAYS} 天 · bot 回复 ${hits.length} 条 · 每条对前 ${LOOKBACK} 条同群人话`);
console.log(`  与前文 0 bigram 重合：${zero} 条（${(zero / hits.length * 100).toFixed(1)}%）`);
console.log(`  重合数分布：${Object.entries(dist).map(([k, v]) => `${k}:${v}`).join('  ')}`);
console.log('  （单边判据：0 重合只能说明"开头与前文无关"，不能证明整条不搭）');
void withFullText;
