#!/usr/bin/env -S env PATH=/opt/node22/bin:$PATH node
/**
 * 量「用户发出 → bot 真的发出回复」的端到端延迟。
 *
 * 为什么要有这个脚本：
 *   2026-09-22 用户报"消息从发出到bot收到4-6s、bot反应10-16s、发出去3-4s，
 *   叠加起来显得迟钝、前言不搭后语"。当时 subagent 量出七天基线：
 *     t0→sendText P50 27.8s / P90 54.4s（n=2194）
 *   修了五处之后需要能**反复量**，而不是每次临时写 python。
 *
 * 方法（和 subagent 的原版一致，消息级配对）：
 *   每条 `host sendText` 往前找**同群最近的** `message in`，
 *   差就是端到端延迟。窗口 120s（超过认为不是因果关系）。
 *
 * 用法：
 *   node scripts/measure-reply-latency.mjs [日志路径] [--since HH:MM]
 *   不带参 = logs/app.log 全量。
 *
 * 注意：样本少的时候 P50 会剧烈跳动（本轮实测 n=12 时 P50 从 10.7 跳到 28.4，
 * 只因为多了一条 115s 的）。**看分布，别只看单点。**
 */
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const logPath = args.find((a) => !a.startsWith('--')) ?? 'logs/app.log';
const sinceIdx = args.indexOf('--since');
const sinceStr = sinceIdx >= 0 ? args[sinceIdx + 1] : null;

/** 解析一行 JSON 日志；非 JSON / 非对象返回 null。 */
function parse(line) {
  if (!line.startsWith('{')) return null;
  try {
    const d = JSON.parse(line);
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}

const ins = new Map();   // chatId -> number[]
const snds = new Map();  // chatId -> number[]
let lines = 0;

const rl = readline.createInterface({ input: createReadStream(logPath), crlfDelay: Infinity });
for await (const line of rl) {
  const d = parse(line);
  if (!d) continue;
  lines++;
  const t = Number(d.time ?? 0);
  if (!t) continue;
  if (sinceStr) {
    // --since HH:MM 按 UTC 当天该时刻过滤
    const [hh, mm] = sinceStr.split(':').map(Number);
    const dayStart = new Date(d.time).setUTCHours(0, 0, 0, 0);
    if (t < dayStart + ((hh * 60 + mm) * 60_000)) continue;
  }
  const c = Number(d.chatId ?? 0);
  const msg = String(d.msg ?? '');
  if (msg === 'message in') {
    if (!ins.has(c)) ins.set(c, []);
    ins.get(c).push(t);
  } else if (msg.startsWith('host sendText')) {
    if (!snds.has(c)) snds.set(c, []);
    snds.get(c).push(t);
  }
}

/** 每条 sendText 往前找同群最近的 message in。 */
const lat = [];
for (const [c, st] of snds) {
  const it = (ins.get(c) ?? []).sort((a, b) => a - b);
  for (const t of st) {
    // 二分：最后一个 <= t 的入站
    let lo = 0, hi = it.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (it[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best >= 0 && t - it[best] <= 120_000) lat.push((t - it[best]) / 1000);
  }
}

lat.sort((a, b) => a - b);
const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0);
console.log(`日志 ${logPath}  共扫 ${lines} 行`);
console.log(`配对 ${lat.length} 条（每条 sendText 配同群最近的 message in，窗口 120s）`);
if (!lat.length) { console.log('无样本'); process.exit(0); }
console.log(`  min  ${lat[0].toFixed(1)}s`);
console.log(`  P50  ${pct(0.5).toFixed(1)}s`);
console.log(`  P90  ${pct(0.9).toFixed(1)}s`);
console.log(`  max  ${lat[lat.length - 1].toFixed(1)}s`);
const buckets = [[0, 1], [1, 5], [5, 15], [15, 30], [30, 60], [60, Infinity]];
console.log('  分布：');
for (const [lo, hi] of buckets) {
  const n = lat.filter((x) => x >= lo && x < hi).length;
  if (n) console.log(`    ${String(lo).padStart(3)}-${hi === Infinity ? '∞' : String(hi).padEnd(3)}s  ${String(n).padStart(4)} 条  ${'█'.repeat(Math.round(n * 40 / lat.length))}`);
}
console.log('\n参考基线（2026-09-22 subagent 七天全量 n=2194）：P50 27.8s / P90 54.4s');
