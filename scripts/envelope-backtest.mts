/**
 * Nyat Trench · L1 包络历史回测（Envelope Backtest）
 *
 * 两轮之前这个脚本只有一个口径：拿**未放大的现状**当分母。所以 150/100 的结论是
 * "拦截 0.1%，对现有行为几乎无影响，可以直接拨"——那回答的是"碍不碍事"，
 * **不是**这个包络存在的理由。它要接住的是判定点扶正后的放大（实测最忙群
 * 22%→86% = 3.9x）。
 *
 * 同一个"分母选错"的错误我在判定点一致率上犯过一次（messageId join + 睡眠相位），
 * 所以这里把两个分母都算出来，判读只用投影口径。
 *
 * 用法：
 *   npx tsx scripts/envelope-backtest.mts [天数] [addressed上限] [active上限] [窗口秒]
 *   npx tsx scripts/envelope-backtest.mts [天数] 150 100 3600 --project 3.9
 */

import { execSync } from 'node:child_process';

const DAYS = Number(process.argv[2] ?? 3);
const MAX_ADDR = Number(process.argv[3] ?? 150);
const MAX_ACTIVE = Number(process.argv[4] ?? 100);
const WIN = Number(process.argv[5] ?? 3600);
const PROJECT_FLAG = process.argv.indexOf('--project');
const PROJECT = PROJECT_FLAG > 0 ? Number(process.argv[PROJECT_FLAG + 1]) : 1;
const DB = process.env.SQLITE_PATH ?? './data/xxb.db';

const since = Math.floor(Date.now() / 1000) - DAYS * 86400;

interface Row { chat_id: number; ts: number; trigger_msg_id: number | null }
function sql(q: string): Row[] {
  const out = execSync(`sqlite3 -json "${DB}" "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : [];
}

const realRows = sql(`SELECT chat_id, ts, trigger_msg_id FROM self_replies WHERE ts >= ${since} ORDER BY ts ASC`);

// 投影：保留真实的时间/突发结构，只把每条发送在同窗口内复制 (N-1) 份。
// 不改形状，只改密度 → 测的是"同样的群在同样的热闹时段被要求更密地说"。
// 刻意不重新生成时间序列：那会比现实更规律，回测就失去意义。
const rows = PROJECT > 1
  ? realRows.flatMap((r) => Array.from({ length: Math.round(PROJECT) }, () => ({ ...r })))
  : realRows;

interface Stat {
  total: number;
  blocked: number;
  addrBlocked: number;
  activeBlocked: number;
  perChat: Array<[number, { total: number; blocked: number }]>;
}

function simulate(rowsIn: Row[]): Stat {
  const buckets = new Map<string, number>();
  const perChat = new Map<number, { total: number; blocked: number }>();
  let blocked = 0;
  let addrBlocked = 0;
  let activeBlocked = 0;

  for (const r of rowsIn) {
    const bucket = Math.floor(r.ts / WIN);
    const k = `${r.chat_id}:${bucket}`;
    const used = buckets.get(k) ?? 0;
    const addressed = r.trigger_msg_id !== null && r.trigger_msg_id > 0;
    const cap = addressed ? MAX_ADDR : MAX_ACTIVE;
    const stat = perChat.get(r.chat_id) ?? { total: 0, blocked: 0 };
    stat.total += 1;
    if (used >= cap) {
      blocked += 1;
      stat.blocked += 1;
      if (addressed) addrBlocked += 1;
      else activeBlocked += 1;
    } else {
      buckets.set(k, used + 1);
    }
    perChat.set(r.chat_id, stat);
  }
  return {
    total: rowsIn.length,
    blocked,
    addrBlocked,
    activeBlocked,
    perChat: [...perChat.entries()].sort((a, b) => b[1].blocked - a[1].blocked),
  };
}

const base = simulate(realRows);
const proj = PROJECT > 1 ? simulate(rows) : null;

const rate = proj ? proj.blocked / Math.max(proj.total, 1) : base.blocked / Math.max(base.total, 1);
const s = proj ?? base;
const pct = (n: number, d: number) => `${((n / Math.max(d, 1)) * 100).toFixed(1)}%`;

console.log(`\n═══ L1 包络历史回测 · 近 ${DAYS} 天${proj ? ` · 投影 ${Math.round(PROJECT)}x` : ''} ═══\n`);
console.log(`参数：被叫到 ${MAX_ADDR} 条 / 主动 ${MAX_ACTIVE} 条，每 ${WIN} 秒一个窗口`);

console.log(`\n── 两个分母 ──`);
console.log(`  现状 ${base.total} 条 → 拦 ${base.blocked}（${pct(base.blocked, base.total)}）`);
if (proj) console.log(`  投影 ${proj.total} 条 → 拦 ${proj.blocked}（${pct(proj.blocked, proj.total)}）  ← 判读用这个`);
if (base.blocked === 0 && (proj?.blocked ?? 0) > 0) {
  console.log(`  ⚠️ 现状 0 拦而投影有拦：这正是"分母选错"的形状——只看现状会把没装上的闸判成合格。`);
}

if (s.total === 0) {
  console.log('\n窗口内没有发言——没有可回测的数据。\n');
  process.exit(0);
}

console.log(`\n本来会被拦：${s.blocked} 条（${pct(s.blocked, s.total)}）`);
console.log(`  其中被叫到的：${s.addrBlocked} 条（回复密度问题）`);
console.log(`  其中主动的：${s.activeBlocked} 条（主动插话太密）\n`);

console.log('分群（按拦截数排序，前 8）：');
for (const [chat, st] of s.perChat.slice(0, 8)) {
  if (st.blocked === 0) continue;
  console.log(`  chat ${chat}: 拦 ${st.blocked}/${st.total}（${pct(st.blocked, st.total)}）`);
}

console.log(`\n── 判读（${proj ? `投影 ${Math.round(PROJECT)}x` : '现状'}口径）──`);
if (rate < 0.01) console.log('拦截率 <1%：这个包络在放大场景下几乎不发力——可能太松。');
else if (rate < 0.05) console.log('拦截率 1~5%：刹车很轻。若想更稳，降到 150/100 一档。');
else if (rate < 0.15) console.log('拦截率 5~15%：会实质削掉一成放大后的发送。这是"接得住"的重量级。');
else console.log('拦截率 >15%：在放大场景下砍得太狠，等于用静音代替抑制。');
console.log('');
