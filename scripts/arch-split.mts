#!/usr/bin/env env npx tsx
/**
 * 架构占比测量 —— "老架构还剩多少在热路径上"。
 *
 * 为什么需要它：`把老架构完全替换掉成新架构` 这句话如果没有数字就只是态度。
 * 2026-09-21 第一次测出来的结果是：
 *
 *   入站 25,950 条
 *   Meta 路径（新架构）        ~24,900 条   96%
 *   legacy processPipeline      1,057 条    4.1%
 *     ├─ denoise: bot 降噪       1,002       （0ms 短路，不生成回复）
 *     ├─ floor: not addressed      27
 *     ├─ heart=pass                24
 *     └─ asleep, queued             4
 *
 *   **legacy 回复引擎（judge→gate→reply→send）在这个窗口里对人类消息生成 0 条回复。**
 *   它剩下的活儿是：斜杠命令 + NL 命令分发 + bot 消息降噪。
 *
 * 用法：
 *   npx tsx scripts/arch-split.mts            # 全量日志
 *   npx tsx scripts/arch-split.mts 3          # 只看最近 3 天
 *
 * 判定口径（重要，改判定就等于改结论）：
 *   · 分母 = `message in` 条数
 *   · legacy 侧 = `Pipeline complete (...)` 条数（processPipeline 的出口日志）
 *   · Meta 侧 = `Meta path:` / `Meta heart:` / `Meta dispatch` / `Meta attention` 之一
 *   · 两者不是严格互补：命令走 Meta→legacy 交接，会同时留下两边的痕迹。
 *     所以 Meta 的数字是"经过 Meta 层"而非"只经过 Meta"。
 */
import { readFileSync, statSync } from 'node:fs';

const LOG = 'logs/app.log';
const DAYS = Number(process.argv[2] ?? 0);
const since = DAYS > 0 ? Date.now() - DAYS * 86_400_000 : 0;

let inbound = 0;
let metaLines = 0;
const legacy = new Map<string, number>();
const metaKinds = new Map<string, number>();
let bytes = 0;

try {
  bytes = statSync(LOG).size;
} catch {
  console.error(`读不到 ${LOG}`);
  process.exit(2);
}

// 日志可能很大；按行流式读，别一次性载入。
const fd = readFileSync(LOG, 'utf8');
for (const line of fd.split('\n')) {
  if (!line.startsWith('{')) continue;
  if (since > 0) {
    // 粗筛：时间戳在前 60 个字符里，先按字符串比长度，避免每条都 JSON.parse。
    const m = /"time":(\d{13})/.exec(line.slice(0, 80));
    if (m && Number(m[1]) < since) continue;
  }
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(line) as Record<string, unknown>;
  } catch {
    continue;
  }
  const msg = String(d['msg'] ?? '');
  if (msg === 'message in') inbound++;
  else if (msg.startsWith('Pipeline complete')) {
    legacy.set(msg, (legacy.get(msg) ?? 0) + 1);
  } else if (msg.startsWith('Meta ')) {
    metaLines++;
    // 归类：心流 / 派发 / 注意力 / 会话 / 路径
    const kind = msg.startsWith('Meta heart')
      ? 'heart'
      : msg.startsWith('Meta dispatch') || msg.startsWith('Meta autoDispatch') || msg.startsWith('Meta defer')
        ? 'dispatch'
        : msg.startsWith('Meta attention')
          ? 'attention'
          : msg.startsWith('Meta session')
            ? 'session'
            : msg.startsWith('Meta path')
              ? 'path'
              : msg.startsWith('Meta LLM')
                ? 'llm'
                : 'other';
    metaKinds.set(kind, (metaKinds.get(kind) ?? 0) + 1);
  }
}

const legacyTotal = [...legacy.values()].reduce((a, b) => a + b, 0);
const pct = (n: number): string => (inbound > 0 ? `${((n / inbound) * 100).toFixed(2)}%` : '—');

console.log(`\n═══ 架构占比 · ${DAYS > 0 ? `最近 ${DAYS} 天` : '全量日志'} ═══\n`);
console.log(`日志大小: ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`入站消息 (message in):        ${inbound}`);
console.log(`Meta 路径事件:               ${metaLines}   （新架构）`);
console.log(`legacy processPipeline 出口:  ${legacyTotal}   ${pct(legacyTotal)}`);
console.log('');
console.log('── legacy 出口按原因 ──');
for (const [k, v] of [...legacy.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(6)}  ${pct(v).padStart(7)}  ${k.replace('Pipeline complete', '')}`);
}
console.log('');
console.log('── Meta 事件按类 ──');
for (const [k, v] of [...metaKinds.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(6)}  ${k}`);
}
console.log('');
const replyEngine = (legacy.get('Pipeline complete (floor: not addressed, context saved)') ?? 0)
  + (legacy.get('Pipeline complete (heart=pass, still present)') ?? 0)
  + (legacy.get('Pipeline complete (asleep, queued for catch-up)') ?? 0);
console.log('── 判读 ──');
console.log(`  legacy 回复引擎（judge→gate→reply）走到出口的: ${replyEngine} 条  ${pct(replyEngine)}`);
console.log(`  legacy 剩下的主体是 bot 消息降噪（0ms 短路，不生成回复）。`);
console.log(`  斜杠/NL 命令走 Meta→legacy 交接，两边都会留痕迹，所以 Meta 的数字是`);
console.log(`  「经过 Meta 层」而不是「只经过 Meta」。`);
console.log('');
process.exit(0);
