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
const act = { reply: 0, wait: 0, pass: 0 } as Record<string, number>;
const anchor = new Map<string, number>();
let collision = 0;
let dupAnchorDropped = 0;
const actByHour = new Map<string, { r: number; w: number; p: number }>();

const rl = readline.createInterface({ input: createReadStream('logs/app.log'), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.startsWith('{')) continue;
  let d: Record<string, unknown>;
  try { d = JSON.parse(line); } catch { continue; }
  if (!d || typeof d !== 'object') continue;
  const t = typeof d.time === 'number' ? d.time : 0;
  if (t < cutoff) continue;
  const m = String(d.msg ?? '');
  if (m === 'message in') { msgs++; continue; }
  if (m === 'host sendText') {
    first++;
    const a = d.replyTo;
    if (typeof a === 'number' && a > 0) {
      const k = `${d.chatId}:${a}`;
      anchor.set(k, (anchor.get(k) ?? 0) + 1);
    }
    continue;
  }
  if (m === 'host sendText continuation' || m === 'host sendText segmented') { cont++; continue; }
  if (m === 'Heart decision') {
    // 这个字段是 time 之外的次要键；从 d 取 act
    const a = String(d.act ?? '');
    if (a in act) act[a] = (act[a] ?? 0) + 1;
    const hour = new Date(t).toISOString().slice(0, 13) + 'Z';
    const rec = actByHour.get(hour) ?? { r: 0, w: 0, p: 0 };
    if (a === 'reply') rec.r++; else if (a === 'wait') rec.w++; else if (a === 'pass') rec.p++;
    actByHour.set(hour, rec);
    continue;
  }
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
console.log(P(`② 心流三态        reply ${act.reply} (${actTotal ? (act.reply * 100 / actTotal).toFixed(0) : 0}%)  wait ${act.wait} (${actTotal ? (act.wait * 100 / actTotal).toFixed(0) : 0}%)  pass ${act.pass} (${actTotal ? (act.pass * 100 / actTotal).toFixed(0) : 0}%)   n=${actTotal}`));
console.log(P(`   wait 是 round 3 新加的中间档，修前 0-6 次/天。wait=0 说明它还是废的。`));
console.log();
console.log(P(`③ 重复回复率      ${dupRate.toFixed(1)}%   多出 ${extra} / 首气泡 ${first}`));
console.log(P(`   同一锚点被回 >1 次的: ${[...anchor.values()].filter((v) => v > 1).length} 个；最惨的被回 ${Math.max(0, ...anchor.values())} 次。`));
console.log(P(`   (同任务内分句去重 dropped duplicate anchor ${dupAnchorDropped} 次是正常工作的，不算重复。)`));
console.log();
console.log(P(`④ 撞名守卫        拦下 ${collision} 次`));
console.log(P(`   round 5 加：用户闲聊提"签到"不该变成一次真的代发。`));
console.log();
if (actByHour.size > 1) {
  console.log(P('按小时 reply%：'));
  for (const h of [...actByHour.keys()].sort()) {
    const r = actByHour.get(h)!;
    const n = r.r + r.w + r.p;
    if (n < 10) continue;
    console.log(P(`   ${h}  n=${String(n).padStart(4)}  reply=${String(r.r).padStart(4)}(${(r.r * 100 / n).toFixed(0).padStart(2)}%)  wait=${r.w}  pass=${String(r.p).padStart(4)}`));
  }
}
console.log();
