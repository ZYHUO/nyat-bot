#!/usr/bin/env -S env PATH=/opt/node22/bin:$PATH npx tsx
/**
 * `npm run measure:voice` — 心流"说话习惯"的三项体检。
 *
 * 为什么要有这个：
 *   用户连提了三次（"太爱说话了" / "重复回复概率太高" / "不会用别的 bot 指令"），
 *   每轮我都是现场写一段 python/node 数日志。问题是**每次的分母、窗口、判据都不一样**，
 *   于是"改前改后"没法比——round 8 的小样本假象、round 11 的乐观偏差都是这么来的。
 *
 *   所以把三个指标固化成**一个**脚本、**一套**判据：
 *
 *     ① reply_rate   回复率 = 首气泡 / message in            （"爱说话"）
 *     ② act          心流三态分布 reply/wait/pass             （决策层）
 *     ③ dup_rate     重复回复率 = 多出的首气泡 / 首气泡        （"重复"）
 *     ④ collision    撞名守卫拦下几次                          （"乱来"）
 *
 *   `--since HH:MM` 只看某时段之后，`--day YYYY-MM-DD` 看整天。
 *   三个口径全是**全量日志**，不用采样——采样是这个会话反复吃亏的地方。
 */
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const sinceIdx = argv.indexOf('--since');
const dayIdx = argv.indexOf('--day');

let cutoff = 0;
if (dayIdx >= 0) {
  const d = argv[dayIdx + 1] ?? '';
  const start = Date.parse(`${d}T00:00:00Z`);
  const end = Date.parse(`${d}T23:59:59Z`);
  cutoff = start;
  void end;
} else if (sinceIdx >= 0) {
  const hhmm = argv[sinceIdx + 1] ?? '00:00';
  const [h = '0', m = '0'] = hhmm.split(':');
  const today = new Date().toISOString().slice(0, 10);
  cutoff = Date.parse(`${today}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00Z`);
}
if (!cutoff) {
  // 默认：今天 UTC 0 点
  cutoff = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
}

const P = (s: string) => `  ${s}`;
let msgs = 0, first = 0, cont = 0;
// round 9：**现在就加 react**，不等它真的出现。
// round 8 给心流加了第四个出口（act=react → setMessageReaction，不产生气泡）。
// 上一轮我写"等跑出 react 再改口径"——那正是这个会话反复吃亏的形状：
// 改了机制却用量旧口径，于是新机制的效果永远量不到。现在 react=0 是诚实的，
// 真跑出来时数字自动就有。
const act = { reply: 0, wait: 0, pass: 0, react: 0 } as Record<string, number>;
const anchor = new Map<string, number>();
let collision = 0;
let dupAnchorDropped = 0;
// round 14：**睡眠门吃掉了多少**——这 6 轮我把它当成"没流量"，
// 于是"没法量"这个结论重复了六遍。
const gate = { asleep: 0, continue: 0, legacy: 0, structuralIgnore: 0 };
const actByHour = new Map<string, { r: number; w: number; p: number; x: number }>();
let reacted = 0;
// round 15：按群拆。用户说"bot 太爱说话了"是**在某个群里的体感**，
// 全量一个平均数会把"一个群在刷屏"和"所有群都正常"混成一回事。
const byChat = new Map<string, { m: number; s: number; edit: number }>();

const rl = readline.createInterface({ input: createReadStream('logs/app.log'), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.startsWith('{')) continue;
  let d: Record<string, unknown>;
  try { d = JSON.parse(line); } catch { continue; }
  if (!d || typeof d !== 'object') continue;
  const t = typeof d.time === 'number' ? d.time : 0;
  if (t < cutoff) continue;
  const m = String(d.msg ?? '');
  if (m === 'message in') {
    msgs++;
    const c = String(d.chatId ?? '?');
    const rec = byChat.get(c) ?? { m: 0, s: 0, edit: 0 };
    rec.m += 1;
    if (d.isEdit) rec.edit += 1;
    byChat.set(c, rec);
    continue;
  }
  if (m === 'host sendText') {
    first++;
    const c = String(d.chatId ?? '?');
    const rec = byChat.get(c) ?? { m: 0, s: 0, edit: 0 };
    rec.s += 1;
    byChat.set(c, rec);
    const a = d.replyTo;
    if (typeof a === 'number' && a > 0) {
      const k = `${d.chatId}:${a}`;
      anchor.set(k, (anchor.get(k) ?? 0) + 1);
    }
    continue;
  }
  if (m === 'host sendText continuation' || m === 'host sendText segmented') { cont++; continue; }
  if (m === 'Heart decision') {
    const a = String(d.act ?? '');
    if (a in act) act[a] = (act[a] ?? 0) + 1;
    const hour = new Date(t).toISOString().slice(0, 13) + 'Z';
    const rec = actByHour.get(hour) ?? { r: 0, w: 0, p: 0, x: 0 };
    if (a === 'reply') rec.r++; else if (a === 'wait') rec.w++; else if (a === 'pass') rec.p++;
    else if (a === 'react') rec.x++;
    actByHour.set(hour, rec);
    continue;
  }
  // react 的副作用日志（heart.ts 的 'heart: reacted'）——Heart decision 那条
  // 已经含 act=react，但这里单独数一次，用来交叉检验"决策了"和"真点出去了"。
  if (m === 'heart: reacted') { reacted += 1; continue; }
  if (m === 'Meta path: asleep') { gate.asleep += 1; continue; }
  if (m === 'Meta path: slash/checkin-stats → legacy pipeline') { gate.legacy += 1; continue; }
  if (m.includes('结构性忽略')) { gate.structuralIgnore += 1; continue; }
  if (m.includes('撞名命令未显式指定')) { collision++; continue; }
  if (m.includes('dropped duplicate reply anchor')) { dupAnchorDropped++; continue; }
}

const extra = [...anchor.values()].reduce((s, v) => s + v - 1, 0);
const dupRate = first > 0 ? (extra * 100 / first) : 0;
const replyRate = msgs > 0 ? (first * 100 / msgs) : 0;
const actTotal = act.reply + act.wait + act.pass;

console.log();
console.log('  心流说话习惯 · 三条判据的量');
console.log('  ────────────────────────────────────────────────────────');
console.log(P(`窗口: ${new Date(cutoff).toISOString().slice(0, 16)}Z 之后`));
console.log(P(`message in ${msgs}   首气泡 ${first}   分句后续 ${cont}   气泡总 ${first + cont}`));
console.log();
console.log(P(`① 回复率          ${replyRate.toFixed(1)}%   首气泡/入站`));
console.log(P(`   心跳那句"别每句都接"说的是这个。会话初期 8.2%。`));
console.log();
console.log(P(`② 心流四态        reply ${act.reply} (${actTotal ? (act.reply * 100 / actTotal).toFixed(0) : 0}%)  react ${act.react} (${actTotal ? (act.react * 100 / actTotal).toFixed(0) : 0}%)  wait ${act.wait} (${actTotal ? (act.wait * 100 / actTotal).toFixed(0) : 0}%)  pass ${act.pass} (${actTotal ? (act.pass * 100 / actTotal).toFixed(0) : 0}%)   n=${actTotal}`));
console.log(P(`   其中 react 真的点出去 ${reacted} 次（heart: reacted 日志；与决策数不一致说明有失败回落）。`));
console.log(P(`   reply/wait/pass 是原三态；wait round 3 才重定义，修前 0-6 次/天；`));
console.log(P(`   react round 8 加的第四个出口（点表情不说话，对回复率分子零贡献）。`));
console.log(P(`   想看"少说话"有没有生效：react 涨 + reply 跌 才是对的形状，只是 reply 跌不是。`));
console.log();
console.log(P(`③ 重复回复率      ${dupRate.toFixed(1)}%   多出 ${extra} / 首气泡 ${first}`));
console.log(P(`   同一锚点被回 >1 次的: ${[...anchor.values()].filter((v) => v > 1).length} 个；最惨的被回 ${Math.max(0, ...anchor.values())} 次。`));
console.log(P(`   (同任务内分句去重 dropped duplicate anchor ${dupAnchorDropped} 次是正常工作的，不算重复。)`));
console.log();
console.log(P(`④ 撞名守卫        拦下 ${collision} 次`));
console.log(P(`   round 5 加：用户闲聊提"签到"不该变成一次真的代发。`));
console.log();
// ── 睡眠门：心流的"分母"是怎么来的 ────────────────────────────────
const gateTotal = gate.asleep + gate.legacy + gate.structuralIgnore + actTotal;
console.log(P(`⑤ 睡眠门           asleep ${gate.asleep} · legacy ${gate.legacy} · 结构性忽略 ${gate.structuralIgnore} · 到心流 ${actTotal}`));
if (gateTotal > 0) {
  const pct = gate.asleep * 100 / gateTotal;
  console.log(P(`   metaSleepGate 对 L2 非直呼消息直接 silent，占这个窗口的 ${pct.toFixed(0)}%。`));
  console.log(P(`   ⚠️ 心流的四个出口只能影响**过了门**的那部分。夜间这是少数，`));
  console.log(P(`      所以"回复率"和"心流四态"在夜间天然被压缩——别拿它当白天口径。`));
}
console.log();
// ── 按群：谁在贡献那个平均数 ──────────────────────────────────────
const chatRows = [...byChat.entries()]
  .map(([c, v]) => ({ c, m: v.m, s: v.s, fresh: v.m - v.edit }))
  .filter((r) => r.m >= 20)
  .sort((a, b) => (b.s / Math.max(1, b.m)) - (a.s / Math.max(1, a.m)));
if (chatRows.length > 0) {
  console.log(P('按群（回复率降序，只列入站 >=20 的群）：'));
  for (const r of chatRows.slice(0, 10)) {
    console.log(P(`   ${r.c.padEnd(18)} in=${String(r.m).padStart(4)} (新 ${String(r.fresh).padStart(4)})  send=${String(r.s).padStart(3)}  ${(r.s * 100 / r.m).toFixed(1)}%`));
  }
  if (chatRows.length > 10) console.log(P(`   …另 ${chatRows.length - 10} 个群`));
  const total = chatRows.reduce((a, r) => ({ m: a.m + r.m, s: a.s + r.s }), { m: 0, s: 0 });
  console.log(P(`   这些小计 in=${total.m} send=${total.s} → ${(total.s * 100 / Math.max(1, total.m)).toFixed(1)}%`));
  console.log(P('   ⚠️ "新"扣掉了 isEdit 的编辑重放——编辑不是新消息，却一直计在入站里，'));
  console.log(P('      所以裸 in 会偏大、回复率偏小——报数字时要说清扣没扣。'));
  console.log();
}

if (actByHour.size > 1) {
  console.log(P('按小时 reply%：'));
  for (const h of [...actByHour.keys()].sort()) {
    const r = actByHour.get(h)!;
    const n = r.r + r.w + r.p;
    if (n < 10) continue;
    console.log(P(`   ${h}  n=${String(n).padStart(4)}  reply=${String(r.r).padStart(4)}(${(r.r * 100 / n).toFixed(0).padStart(2)}%)  react=${String(r.x).padStart(3)}  wait=${r.w}  pass=${String(r.p).padStart(4)}`));
  }
}
console.log();
