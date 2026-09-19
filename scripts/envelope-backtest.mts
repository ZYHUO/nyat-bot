/**
 * Nyat Trench · L1 包络的历史回测（Envelope Backtest）
 *
 * 为什么需要它：包络部署在 shadow 模式，要等真实流量才知道"拨 enforce 会不会
 * 改变 bot 行为"。但群在深夜是安静的——连等几轮都拿不到样本。
 *
 * 回测用生产已有的 self_replies（每条发言的时间+群）重放一遍爆场逻辑，
 * 回答同一个问题而不需要等天亮：
 *
 *   「如果昨天就在 enforce，会有多少条发不出去？集中在哪些群？」
 *
 * 用法：npx tsx scripts/envelope-backtest.mts [天数] [addressed上限] [active上限] [窗口秒]
 */

import { execSync } from 'node:child_process';

const DAYS = Number(process.argv[2] ?? 3);
const MAX_ADDR = Number(process.argv[3] ?? 8);
const MAX_ACTIVE = Number(process.argv[4] ?? 3);
const WIN = Number(process.argv[5] ?? 300);
const DB = process.env.SQLITE_PATH ?? './data/xxb.db';

const since = Math.floor(Date.now() / 1000) - DAYS * 86400;

interface Row { chat_id: number; ts: number }
function sql(q: string): Row[] {
  const out = execSync(`sqlite3 -json "${DB}" "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : [];
}

// 一次发言算"被叫到"还是"主动"：self_replies.trigger_msg_id 非空 = 有引用锚点。
const rows = sql(`SELECT chat_id, ts, trigger_msg_id FROM self_replies WHERE ts >= ${since} ORDER BY ts ASC`) as unknown as Array<
  Row & { trigger_msg_id: number | null }
>;

const buckets = new Map<string, number>();       // key = chatId:bucket -> 已用次数
const blocked: Array<{ chat_id: number; ts: number; addressed: boolean }> = [];
const perChat = new Map<number, { total: number; blocked: number }>();

for (const r of rows) {
  const bucket = Math.floor(r.ts / WIN);
  const k = `${r.chat_id}:${bucket}`;
  const used = buckets.get(k) ?? 0;
  const addressed = r.trigger_msg_id !== null && r.trigger_msg_id > 0;
  const cap = addressed ? MAX_ADDR : MAX_ACTIVE;
  const stat = perChat.get(r.chat_id) ?? { total: 0, blocked: 0 };
  stat.total += 1;
  if (used >= cap) {
    blocked.push({ chat_id: r.chat_id, ts: r.ts, addressed });
    stat.blocked += 1;
  } else {
    buckets.set(k, used + 1);
  }
  perChat.set(r.chat_id, stat);
}

const total = rows.length;
const nBlocked = blocked.length;
const addrBlocked = blocked.filter((b) => b.addressed).length;

console.log(`\n═══ L1 包络历史回测 · 近 ${DAYS} 天 ═══\n`);
console.log(`参数：被叫到 ${MAX_ADDR} 条 / 主动 ${MAX_ACTIVE} 条，每 ${WIN} 秒一个窗口`);
console.log(`样本：${total} 条发言\n`);

if (total === 0) {
  console.log('窗口内没有发言——没有可回测的数据。\n');
  process.exit(0);
}

console.log(`本来会被拦：${nBlocked} 条（${((nBlocked / total) * 100).toFixed(1)}%）`);
console.log(`  其中被叫到的：${addrBlocked} 条（说明是回复密度问题）`);
console.log(`  其中主动的：${nBlocked - addrBlocked} 条（说明是主动插话太密）\n`);

console.log('分群（按拦截数排序，前 8）：');
const top = [...perChat.entries()].sort((a, b) => b[1].blocked - a[1].blocked).slice(0, 8);
for (const [chat, st] of top) {
  if (st.blocked === 0) continue;
  console.log(`  chat ${chat}: 拦 ${st.blocked}/${st.total}（${((st.blocked / st.total) * 100).toFixed(1)}%）`);
}

console.log(`\n── 判读 ──`);
const rate = nBlocked / total;
if (rate < 0.01) {
  console.log('拦截率 <1%：enforce 对现有行为几乎无影响，可以直接拨。');
} else if (rate < 0.05) {
  console.log('拦截率 1~5%：影响可测但很小。建议拨 enforce 后观察金丝雀发送量曲线。');
} else if (rate < 0.15) {
  console.log('拦截率 5~15%：会实质改变行为。先调宽窗口或上限，重跑到 <5% 再拨。');
} else {
  console.log('拦截率 >15%：当前参数对这个群太紧。这个包络现在开就是在削活性。');
}
console.log('');
