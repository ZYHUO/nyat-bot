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
  // round 51：**支持 `--since 'YYYY-MM-DD HH:MM'`**（跨日切片）。
  // 原来只吃 HH:MM 并默认取今天——于是"昨天同时段 vs 今天同时段"比不了，
  // 而那是唯一能区分"刚醒来说话多"和"一直都这么多"的比法。
  // 两种形式都收：`23:36`（今天）和 `2026-09-22 23:36`（任意一天）。
  const raw = (argv[sinceIdx + 1] ?? '00:00').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const [datePart, timePart = '00:00'] = raw.split(/\s+/);
    cutoff = Date.parse(`${datePart}T${timePart.padStart(8, '0').slice(0, 8)}Z`);
    if (!Number.isFinite(cutoff)) cutoff = Date.parse(`${datePart}T00:00:00Z`);
  } else {
    const [h = '0', m = '0'] = raw.split(':');
    const today = new Date().toISOString().slice(0, 10);
    cutoff = Date.parse(`${today}T${h.padStart(2, '0')}:${m.padStart(2, '0')}:00Z`);
  }
}
if (!cutoff) {
  // 默认：今天 UTC 0 点
  cutoff = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
}

const P = (s: string) => `  ${s}`;
let msgs = 0, fresh = 0, first = 0, cont = 0;
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
// round 46：漏斗的第五项。之前 27 入站 = 10 忽略 + 6 legacy + 2 到心流 + **9 条无账**。
// 查 message.ts 有 5 处 ingestAsync，其中 4 处**绕过心流**强制入 attention：
//   364 same_speaker_burst（连发的人）· 524 heart→Attention · 559 同上（另一分支）
//   614 heartPath='bypass'（心流说要等/不接但 obligation 未清）
//   700 TRENCH_DEBT_ATTENTION_ENABLED（欠的回复要还）
// 它们都不经过心流决策，所以"心流影响多少流量"要把它们算进分母的另一边。
const gate = { asleep: 0, continue: 0, legacy: 0, structuralIgnore: 0, bypassIngest: 0, coalesceHold: 0 };
const actByHour = new Map<string, { r: number; w: number; p: number; x: number }>();
let reacted = 0;
const reactedEmoji = new Map<string, number>();
// round 15：按群拆。用户说"bot 太爱说话了"是**在某个群里的体感**，
// 全量一个平均数会把"一个群在刷屏"和"所有群都正常"混成一回事。
const byChat = new Map<string, { m: number; s: number; edit: number; first: number }>();

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
    // round 49：isEdit 的重放不是新消息。实测今天 08:00 前 52 条入站里
    // 32 条是编辑重放（62%）—— 分母被这个灌水，"回复率"被系统性低估。
    if (!d.isEdit) fresh += 1;
    const c = String(d.chatId ?? '?');
    const rec = byChat.get(c) ?? { m: 0, s: 0, edit: 0, first: t };
    rec.m += 1;
    if (d.isEdit) rec.edit += 1;
    byChat.set(c, rec);
    continue;
  }
  if (m === 'host sendText') {
    first++;
    const c = String(d.chatId ?? '?');
    const rec = byChat.get(c) ?? { m: 0, s: 0, edit: 0, first: t };
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
  if (m === 'heart: reacted') {
    reacted += 1;
    // round 23：emoji 分布。如果它全挑同一个（或全挑 👍），说明它没在"选"，
    // 只是在满足"要给个表情"这个要求——那 react 就退化成了常量输出。
    const e = String(d.emoji ?? '(没给→回落)');
    reactedEmoji.set(e, (reactedEmoji.get(e) ?? 0) + 1);
    continue;
  }
  if (m === 'Meta path: asleep') { gate.asleep += 1; continue; }
  if (m === 'Meta path: slash/checkin-stats → legacy pipeline') { gate.legacy += 1; continue; }
  if (m.includes('结构性忽略')) { gate.structuralIgnore += 1; continue; }
  // 第六条路径（round 48）：进了 Attention 但被 coalesce 扣着等安静——还没到心流。
  // 这不是 bug（爆发合并是设计），但它是漏斗最后一块：不数它，
  // "到心流"和"入站"之间永远差一截解释不清。
  // ⚠️ coalesce hold 是**事件**不是消息（一批消息对应一次 hold），
  // 所以它只单独报数、不进 gateTotal——否则分母虚高，占比全错。
  if (m.includes('Attention coalesce hold')) { gate.coalesceHold += 1; continue; }
  // 绕过心流强制入 attention 的四类（都不烧心流决策）
  // 只有这两个是绕过心流的直摄：
  //   same_speaker_burst —— 连发的人，不问心流
  //   bypass             —— 心流说了不等但 obligation 没清
  // 'Meta attention ingested (heart)' 不算：那是心流**做了决策**之后入 attention 的，
  // 属于产出不是绕过。（第一版把它也算进去了，456/473 的差就是这么来的。）
  if (m === 'Meta attention ingested (same_speaker_burst)') { gate.bypassIngest += 1; continue; }
  if (m.includes('bypass')) { gate.bypassIngest += 1; continue; }
  if (m.includes('撞名命令未显式指定')) { collision++; continue; }
  if (m.includes('dropped duplicate reply anchor')) { dupAnchorDropped++; continue; }
}

const extra = [...anchor.values()].reduce((s, v) => s + v - 1, 0);
const dupRate = first > 0 ? (extra * 100 / first) : 0;
// round 49：**回复率的分母改成新消息**（扣掉 isEdit 的重放）。
// 旧口径（含编辑）保留在括号里，因为历史数字是那个口径——
// 但现在它会低估：今天 08:00 前 62% 的"入站"是编辑重放。
const replyRate = fresh > 0 ? (first * 100 / fresh) : 0;
const actTotal = act.reply + act.wait + act.pass;

console.log();
console.log('  心流说话习惯 · 三条判据的量');
console.log('  ────────────────────────────────────────────────────────');
console.log(P(`窗口: ${new Date(cutoff).toISOString().slice(0, 16)}Z 之后`));
console.log(P(`message in ${msgs}（新消息 ${fresh}，编辑重放 ${msgs - fresh}）  首气泡 ${first}   分句后续 ${cont}   气泡总 ${first + cont}`));
// round 40：**空窗口禁结论**。voice:phase 说"可以量"只答了"相对不对"，
// 没答"有没有流量"——刚起床那几分钟两者都成立而 n=0，五个数全是 0/0。
// 那看着像"完美收敛"（回复率 0%！），其实是没有样本。
// compare 里早有为这个写的判据（任一面板载荷 0 -> 没得比），
// 单跑的这份没有——补上，同一个病不该只修一半。
if (msgs < 20) {
  console.log(P(`⚠️ 入站只有 ${msgs} 条 —— **下面的比率全是 0/0，不算数**。`));
  console.log(P(`   0% 回复率在这里的含义是"没有样本"，不是"它很收敛"。`));
  console.log(P(`   等群里真的有人说话再读。（20 条是随手定的下限，n<20 的百分比别引用。）`));
}
console.log();
console.log(P(`① 回复率          ${replyRate.toFixed(1)}%   首气泡/入站`));
console.log(P(`   心跳那句"别每句都接"说的是这个。会话初期 8.2%。`));
console.log();
console.log(P(`② 心流四态        reply ${act.reply} (${actTotal ? (act.reply * 100 / actTotal).toFixed(0) : 0}%)  react ${act.react} (${actTotal ? (act.react * 100 / actTotal).toFixed(0) : 0}%)  wait ${act.wait} (${actTotal ? (act.wait * 100 / actTotal).toFixed(0) : 0}%)  pass ${act.pass} (${actTotal ? (act.pass * 100 / actTotal).toFixed(0) : 0}%)   n=${actTotal}`));
console.log(P(`   其中 react 真的点出去 ${reacted} 次（heart: reacted 日志；与决策数不一致说明有失败回落）。`));
if (reactedEmoji.size > 0) {
  const dist = [...reactedEmoji.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}×${n}`).join(' ');
  console.log(P(`   emoji 分布: ${dist}`));
  // 单一表情占绝对多数 = 它没在选，只是走流程
  const top = [...reactedEmoji.values()].sort((a, b) => b - a)[0]!;
  if (top / reacted > 0.8) {
    console.log(P(`   ⚠️ ${Math.round(top * 100 / reacted)}% 是同一个表情 —— 它不是在"选"，是在交差。`));
    console.log(P(`      prompt 里那句"挑不到对得上的就别用这一档"就没起作用。`));
  }
}
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
// coalesceHold 故意不在分母里：它是事件不是消息（见上面那条注释）。
const gateTotal = gate.asleep + gate.legacy + gate.structuralIgnore + gate.bypassIngest + actTotal;
console.log(P(`⑤ 到心流的漏斗     asleep ${gate.asleep} · legacy ${gate.legacy} · bot未叫本喵 ${gate.structuralIgnore} · 绕过心流直摄 ${gate.bypassIngest} · coalesce扣着 ${gate.coalesceHold} · **到心流 ${actTotal}**`));
if (gateTotal > 0) {
  const pct = (n: number) => (n * 100 / gateTotal).toFixed(0) + '%';
  const reach = actTotal * 100 / gateTotal;
  console.log(P(`   asleep ${pct(gate.asleep)} · bot未叫本喵 ${pct(gate.structuralIgnore)} · legacy ${pct(gate.legacy)} · 绕过直摄 ${pct(gate.bypassIngest)} · coalesce扣着 ${gate.coalesceHold} 次(事件,不计占比)`));
  console.log(P(`   ⚠️ 心流的四个出口只影响**过了整条漏斗**的那部分：${reach.toFixed(0)}%。`));
  console.log(P(`      "绕过心流直摄"是 round 46 才数的一项：连发的人/心流说等但债没清/欠的回复要还，`));
  console.log(P(`      这四类都跳过心流决策直接进 attention。它们是对的，但让上面的 ${reach.toFixed(0)}% 更高估不得。`));
  console.log(P(`      夜间 asleep 是大头，别拿夜间数字当白天口径。`));
}
console.log();
// ── 按群：谁在贡献那个平均数 ──────────────────────────────────────
const chatRows = [...byChat.entries()]
  .map(([c, v]) => {
    // round 17：**条/小时**——用户感知的是"它每隔几分钟就说一句"，不是占比。
    // 占比 18.8% 看着收敛，13 条/小时就是每 4.6 分钟一句，群里的人只会觉得吵。
    const hours = Math.max(0.5, (Date.now() - v.first) / 3_600_000);
    return { c, m: v.m, s: v.s, fresh: v.m - v.edit, perHour: v.s / hours };
  })
  .filter((r) => r.m >= 20)
  // 按条/小时降序，不按占比——更接近人的体感
  .sort((a, b) => b.perHour - a.perHour);
if (chatRows.length > 0) {
  console.log(P('按群（条/小时降序——这才是"吵不吵"的体感；只列入站 >=20 的群）：'));
  for (const r of chatRows.slice(0, 10)) {
    console.log(P(`   ${r.c.padEnd(18)} ${r.perHour.toFixed(1).padStart(5)}条/时  send=${String(r.s).padStart(3)}  in=${String(r.m).padStart(4)} (新 ${String(r.fresh).padStart(4)})  ${(r.s * 100 / r.m).toFixed(1)}%`));
  }
  if (chatRows.length > 10) console.log(P(`   …另 ${chatRows.length - 10} 个群`));
  const total = chatRows.reduce((a, r) => ({ m: a.m + r.m, s: a.s + r.s }), { m: 0, s: 0 });
  console.log(P(`   这些小计 in=${total.m} send=${total.s} → ${(total.s * 100 / Math.max(1, total.m)).toFixed(1)}%`));
  console.log(P('   ⚠️ "新"扣掉了 isEdit 的编辑重放——编辑不是新消息，却一直计在入站里，'));
  console.log(P('      所以裸 in 会偏大、回复率偏小——报数字时要说清扣没扣。'));
  console.log(P('   ⚠️ 占比和条/小时是两个不同的病：占比高 = 话密但群也热；'));
  console.log(P('      条/小时高 = 不管群热不热，它每隔几分钟就冒一句。前者常是正常的，'));
  console.log(P('      后者才是"太爱说话"。我调了 17 轮占比，治的是前一个。'));
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
