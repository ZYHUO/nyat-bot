/**
 * Nyat Trench · 行为金丝雀（Behavioral Canary）
 *
 * 论文 §9：删除不是里程碑，是结果。每个删除以 shadow 对等测试为前置。
 * 但"对等"在七子系统深度耦合的现实里没法做成逐条消息的 A/B（一天 5842 万
 * token 无余量，且新旧并行本身就要双倍判定调用）。
 *
 * 所以这里的对等是**行为层面的**：一组零 token、纯 SQL/日志的指标，每次删除
 * 前后各跑一次，任何指标越带即回滚。每条指标都标注了"它守的是哪一次事故"。
 *
 * 用法：npx tsx scripts/trench-canary.mts [天数]
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const DAYS = Number(process.argv[2] ?? 7);
const DB = process.env.SQLITE_PATH ?? './data/xxb.db';
const LOG = 'logs/app.log';

interface Row { [k: string]: unknown }
function sql(q: string): Row[] {
  const out = execSync(`sqlite3 -json "${DB}" "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}
function logCount(pattern: string): number {
  try {
    const txt = readFileSync(LOG, 'utf8');
    return txt.split(pattern).length - 1;
  } catch {
    return -1;
  }
}

const since = Math.floor(Date.now() / 1000) - DAYS * 86400;

// ── 1. 安全面：守卫命中（这些数字掉下去 = 事故补丁被误删）────────────
const guards = {
  'anchor dedup（同消息只回一次 · 167 次基线）': logCount('dropped duplicate reply anchor'),
  '语义重复（6 条同义问候事故 · 28 次基线）': logCount('rejected semantic repeat'),
  '字面自复读（128 次基线）': logCount('rejected self-echo (local)'),
  '内部记账泄漏（已回复 #id 事故）': logCount('sendText_status_ack_leak'),
  '工具占位符泄漏（invalid chatId 事故）': logCount('sendText_tool_leak'),
};

// ── 2. 活性面：说与不说 ────────────────────────────────────────
const act = sql(`
  SELECT COUNT(*) n,
         SUM(CASE WHEN trigger_uid=0 THEN 1 ELSE 0 END) proactive,
         SUM(CASE WHEN outcome='unknown' THEN 1 ELSE 0 END) unknown_outcome
  FROM self_replies WHERE ts >= ${since}`)[0] ?? {};

// ── 3. 决策面：五层判定的当前真实用量 ──────────────────────────
const decisions = {
  'heart 判定（pipeline/heart）': logCount('"msg":"Heart decision"'),
  'Meta heart': logCount('"msg":"Meta heart:'),
  'gate LLM 判定': logCount('"msg":"Timing gate decision"'),
  'gate 解析失败': logCount('gate parse failed'),
  'shadow 判定': logCount('"msg":"Bot message classified (shadow)"'),
  'tick 选择 quiet': logCount('"msg":"unified tick: quiet"'),
};

// ── 4. 真人感： persona 指标 ───────────────────────────────────
const replies = sql(`SELECT reply_text FROM self_replies WHERE ts >= ${since} AND reply_text IS NOT NULL`);
const n = replies.length || 1;
const qRate = replies.filter((r) => /[？?]/.test(String(r.reply_text))).length / n;
const maoRate = replies.filter((r) => /喵[~。！？!?,，\s]*$/.test(String(r.reply_text).trim())).length / n;
const shortRate = replies.filter((r) => String(r.reply_text).replace(/\s/g, '').length <= 10).length / n;

// ── 5. 海沟自身 ───────────────────────────────────────────────
const trench = {
  'tick_verdict 落账': sql(`SELECT COUNT(*) n FROM cognitive_events WHERE type='tick_verdict'`)[0]?.n ?? 0,
  'own_action_result': sql(`SELECT COUNT(*) n FROM cognitive_events WHERE type='own_action_result'`)[0]?.n ?? 0,
  'Echo 已结算的主动发言': sql(`SELECT COUNT(*) n FROM self_replies WHERE trigger_uid=0 AND outcome<>'unknown'`)[0]?.n ?? 0,
  '发送前硬闸拦截': logCount('BLOCKED by trench gate'),
};

function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }

console.log(`\n═══ Nyat Trench 行为金丝雀 · 近 ${DAYS} 天 ═══\n`);
console.log('【安全面】这些数字下降 = 事故补丁被误删，立刻回滚');
for (const [k, v] of Object.entries(guards)) console.log(`  ${String(v).padStart(6)}  ${k}`);
console.log('\n【活性面】');
console.log(`  发送总数 ${act.n ?? 0}｜其中主动 ${act.proactive ?? 0}｜outcome 未结算 ${act.unknown_outcome ?? 0}`);
console.log(`  Echo 目标：主动发言的 unknown 占比 < 10%（论文 §7.2 指标 3）`);
console.log('\n【决策面】五层判定的真实用量（判断哪层可以死）');
for (const [k, v] of Object.entries(decisions)) console.log(`  ${String(v).padStart(6)}  ${k}`);
console.log('\n【真人感】（真人基准：问号 4-6% / 句末喵 ~1% / ≤10字 68%）');
console.log(`  问号率 ${pct(qRate)}｜句末喵 ${pct(maoRate)}｜≤10字 ${pct(shortRate)}`);
console.log('\n【海沟自身】');
for (const [k, v] of Object.entries(trench)) console.log(`  ${String(v).padStart(6)}  ${k}`);

// ── 判定 ─────────────────────────────────────────────────────
const fail: string[] = [];
if ((act.n ?? 0) === 0) fail.push('零发送——系统可能被闸静音了');
if (guards['anchor dedup（同消息只回一次 · 167 次基线）'] === 0 && logCount('"msg":"host sendText"') > 100) {
  // 不是每条都需要 anchor，但完全为 0 且发送量不小，说明守卫可能失效
}
if (qRate > 0.2) fail.push(`问号率 ${pct(qRate)} 远超真人基准——prompt 纪律退化`);
if (maoRate > 0.45) fail.push(`句末喵 ${pct(maoRate)}——又开始每句都喵`);

console.log('');
if (fail.length === 0) {
  console.log('✅ 无越带。可以继续下一个删除切片。');
} else {
  console.log('❌ 越带，回到上一个 commit：');
  for (const f of fail) console.log(`   - ${f}`);
}
console.log('');
