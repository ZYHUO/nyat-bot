/**
 * Nyat Trench · 醒来行为判定（Wake-up Check）
 *
 * 评审 3（多模型评审第 22 轮）给的可证伪检验。睡眠积压改成定向债之后，"醒来后
 * 前几句是密的"这件事有两种解释，而它们的区分不在速率包络（两者都前高后低），
 * 在**衰减由谁驱动**和**速率被兑付成什么**：
 *
 *   活人：每条锚在夜里堆积的具体人身上，没人接就自己停 → 衰减由闭环驱动
 *   痉挛：速率被 P 顶高，然后只被半衰期压平 → 衰减由 Date.now() 驱动
 *
 * 判据（原话）：醒来后第一小时的消息按 anchor_ok（reply 目标是否落在夜间消息
 * 发送者集合内）、echo_rate 分桶，与同群白天主动发言桶对照。
 *   醒来桶零锚点率 ≥ 主动桶 3 倍 → 痉挛（定向债没起作用）
 *   三桶差异 < 1.5 倍           → 活人（定向债在驱动衰减）
 *
 * 用法：npx tsx scripts/wakeup-check.mts [天数]
 * 没有醒来样本时它会直说"还没有数据"，不猜。
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { getLifeState } from '../src/tracking/life-state.js';

const DAYS = Number(process.argv[2] ?? 3);
// 定向债上线时间（2026-09-19 19:59 UTC）。**只认这之后的醒来**：
// 更早的样本没有债可还，判"活人/痉挛"没有意义；而且 trigger_msg_id 的锚点修复
// 也是中途上线的，老行锚点为 null 但实际有锚点，会把桶污染掉。
const DEBT_SINCE = Math.floor(new Date('2026-09-19T19:59:00Z').getTime() / 1000);
const DB = process.env.SQLITE_PATH ?? './data/xxb.db';
const LOG = 'logs/app.log';
const now = Math.floor(Date.now() / 1000);
const since = now - DAYS * 86400;

interface Row { [k: string]: unknown }
function sql(q: string): Row[] {
  const out = execSync(`sqlite3 -json "${DB}" "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : [];
}

// ── 1. 找出醒来时刻 ────────────────────────────────────────────
// 优先用 trench_wakeup 事件（cron 的相位跳变检测），回退到"发送记录的空档后第一次发送"。
const wakeups: Array<{ at: number; chat: number | null }> = [];
if (existsSync(LOG)) {
  const txt = readFileSync(LOG, 'utf8');
  for (const line of txt.split('\n')) {
    if (!line.includes('trench_wakeup') && !line.includes('trench: bot woke up')) continue;
    try {
      const d = JSON.parse(line) as { time?: number; event?: string };
      if (d.event === 'trench_wakeup' && typeof d.time === 'number') {
        wakeups.push({ at: Math.floor(d.time / 1000), chat: null });
      }
    } catch { /* 跳过坏行 */ }
  }
}

// 睡眠期最后一跳与醒来后第一跳：用"睡着时无发送、醒来后有发送"近似。
const sleeps = sql(`SELECT chat_id AS c, ts FROM self_replies WHERE ts >= ${since} ORDER BY ts ASC`) as unknown as Array<{ c: number; ts: number }>;
if (sleeps.length === 0) {
  console.log('\n窗口内没有 bot 发言——没有可判定的样本。\n');
  process.exit(0);
}

// 用"每群最后一个 >6h 空档后的第一次发送"当醒来候选
const perChat = new Map<number, number[]>();
for (const s of sleeps) {
  const list = perChat.get(s.c) ?? [];
  list.push(s.ts);
  perChat.set(s.c, list);
}
const candidates: Array<{ chat: number; at: number }> = [];
for (const [chat, ts] of perChat) {
  ts.sort((a, b) => a - b);
  for (let i = 1; i < ts.length; i++) {
    if (ts[i]! - ts[i - 1]! >= 6 * 3600) candidates.push({ chat, at: ts[i]! });
  }
}

if (wakeups.length === 0 && candidates.length === 0) {
  console.log('\n还没有醒来样本（既无 trench_wakeup 事件，也无 6h 空档后的首条发言）。');
  console.log('定向债的"活人 vs 痉挛"判定要等一次自然醒来。\n');
  process.exit(0);
}

if (wakeups.length === 0) {
  console.log('\n注意：没有 trench_wakeup 事件，退化为用" 6h 空档后首条发送"近似醒来时刻。');
  console.log('这个近似会比真实醒来晚（睡眠门放开后未必立刻发），所以下面 verdict 偏松。\n');
}

console.log(`\n═══ 醒来行为判定 · 近 ${DAYS} 天 ═══\n`);
console.log(`trench_wakeup 事件：${wakeups.length}｜空档近似候选：${candidates.length}\n`);

/** 夜间消息发送者集合：醒来时刻前 8 小时内，该群里真实发过言的人。 */
function nightSenders(chatId: number, beforeSec: number): Set<number> {
  const rows = sql(
    `SELECT DISTINCT json_extract(fact_json,'$.userId') AS uid FROM cognitive_events
     WHERE type='message_received' AND chat_id=${chatId}
       AND occurred_at >= ${beforeSec - 8 * 3600} AND occurred_at <= ${beforeSec}`,
  );
  const s = new Set<number>();
  for (const r of rows) {
    const u = Number(r['uid']);
    if (Number.isSafeInteger(u) && u > 0) s.add(u);
  }
  return s;
}

/** 一个桶：给定一群、一段时间、一组夜间发送者，统计 bot 发言里有多少锚在他们身上。 */
function bucket(chatId: number, from: number, to: number, senders: Set<number>) {
  const rows = sql(
    `SELECT bot_message_id, trigger_msg_id FROM self_replies
     WHERE chat_id=${chatId} AND ts >= ${from} AND ts < ${to}`,
  ) as unknown as Array<{ bot_message_id: number; trigger_msg_id: number | null }>;
  let anchored = 0;
  let unanchored = 0;
  for (const r of rows) {
    const anchor = r.trigger_msg_id;
    // anchor_ok：有引用锚点（我们无法直接解出被引用的 uid，用"非空锚点"作代理）
    if (anchor !== null && anchor > 0) anchored += 1;
    else unanchored += 1;
  }
  return { total: rows.length, anchored, unanchored, senders: senders.size };
}

const all = [...wakeups.map((w) => ({ chat: w.chat, at: w.at })),
  ...candidates.map((c) => ({ chat: c.chat, at: c.at }))];
const cases = all.filter((c) => c.at >= DEBT_SINCE).slice(0, 10);
const stale = all.length - cases.length;
if (stale > 0) console.log(`（已忽略 ${stale} 个定向债上线前的疑似醒来——那些样本没有债可还）\n`);
if (cases.length === 0) {
  console.log('\n还没有"定向债生效后的醒来"样本。判定要等一次自然醒来。');
  // **醒来时间必须算，不能写死**：这一行原本硬编码"北京 09:09"，而睡眠点是按日
  // seed + 当日发言量偏移的动态值，每天不同、且我修改过行为之后它也会变。
  // （同一个错我在这个会话里犯过六次：写死在数字旁边的叙述不会随数字更新。）
  let wakeBj = '';
  for (let min = 0; min <= 600; min += 5) {
    const t = new Date(Date.now() + min * 60000);
    if (getLifeState(t).state !== 'sleeping') {
      wakeBj = new Date(t.getTime() + 8 * 3600000).toISOString().slice(11, 16);
      break;
    }
  }
  console.log(`bot 当前在睡（醒来约北京 ${wakeBj || '未知'}，即 UTC ${wakeBj ? String((Number(wakeBj.slice(0, 2)) + 16) % 24).padStart(2, '0') + ':' + wakeBj.slice(3) : '-'}），DEBT_SINCE=${new Date(DEBT_SINCE * 1000).toISOString()}\n`);
  process.exit(0);
}

for (const cs of cases) {
  if (cs.chat === null) continue;
  const senders = nightSenders(cs.chat, cs.at);
  if (senders.size === 0) continue;
  const wake = bucket(cs.chat, cs.at, cs.at + 3600, senders);
  const day = bucket(cs.chat, cs.at - 12 * 3600, cs.at - 6 * 3600, senders);
  if (wake.total === 0 || day.total === 0) continue;

  const wakeZero = wake.unanchored / wake.total;
  const dayZero = day.unanchored / day.total;
  // 两者都 0 = 完全一致（不是 0 倍）；白天 0 而醒来 >0 = 醒来明显更散
  const ratio = dayZero === 0 ? (wakeZero === 0 ? 1 : Infinity) : wakeZero / dayZero;

  console.log(`chat ${cs.chat}（醒来 @ ${new Date(cs.at * 1000).toISOString().slice(11, 16)} UTC，夜间发送者 ${senders.size} 人）`);
  console.log(`  醒来桶：${wake.total} 条，无锚点 ${wake.unanchored}（${(wakeZero * 100).toFixed(0)}%）`);
  console.log(`  白天桶：${day.total} 条，无锚点 ${day.unanchored}（${(dayZero * 100).toFixed(0)}%）`);

  let verdict: string;
  if (ratio >= 3) verdict = '痉挛 —— 醒来后的话不指向夜里任何人，定向债没起作用';
  else if (ratio <= 1.5) verdict = '活人 —— 醒来后与白天的锚定分布无实质差异';
  else verdict = '不确定（1.5x ~ 3x 之间）——样本不足或特性部分生效';
  console.log(`  倍数 ${ratio === Infinity ? '∞' : ratio.toFixed(1)}x → ${verdict}\n`);
}

console.log('提示：anchor_ok 用"有引用锚点"作代理（self_replies 不存被引用 uid）。');
console.log('      要精确判据需要 trigger 侧的 uid 映射，属于下一轮可加的埋点。\n');
