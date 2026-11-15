#!/usr/bin/env node
/**
 * `npm run measure:voice:compare` —— 两个时段并排比，专治"单窗口下结论"。
 *
 * 为什么要有：
 *   round 8 就是拿 n=12 的窗口说"P50 从 10.7 掉到 28.4"，其实那是小样本假象；
 *   round 9 的两个窗口负载差 5 倍（昨天 in=2204 / 今天 in=416），同样不可比。
 *   **同一个数字在两个不同负载的窗口里，说明不了任何事。**
 *
 * 用法：
 *   npm run measure:voice:compare -- 23:30 23:45        # 今天的两个 UTC 时段
 *   npm run measure:voice:compare -- day1 day2          # --day 形式
 *
 * 判据写在输出里：载荷差超过 25% 就不许下结论，只报数。
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const [a, b] = args;
if (!a || !b) {
  console.log('用法: npm run measure:voice:compare -- <窗口A> <窗口B>');
  console.log('  例: npm run measure:voice:compare -- 23:30 23:45');
  console.log('  例: npm run measure:voice:compare -- 2026-09-21 2026-09-22   (--day 形式)');
  process.exit(1);
}

// 带日期的都走 --since（那两个都支持 'YYYY-MM-DD HH:MM'），
// 纯 HH:MM 才是 --day 的 --since（取今天）。原来的 isDay 分得太粗，
// 导致 '2026-09-22 23:36' 会被当成 --day 传给 measure，而它只吃 YYYY-MM-DD。
const hasDate = /^\d{4}-\d{2}-\d{2}/.test(a) || /^\d{4}-\d{2}-\d{2}/.test(b);
const flag = hasDate ? '--since' : '--day';

function run(v) {
  const out = execFileSync('npx', ['tsx', 'scripts/measure-voice.mts', flag, v], {
    encoding: 'utf8', timeout: 200_000,
    env: { ...process.env, PATH: '/opt/node22/bin:' + (process.env.PATH ?? '') },
  });
  const grab = (label) => {
    const m = out.match(new RegExp(label + '[^\\n]*'));
    return m ? m[0].replace(new RegExp('.*?' + label + '\\s*'), '').trim() : '(没量到)';
  };
  const rows = [];
  for (const line of out.split('\n')) {
    const mm = line.match(/^\s+(-100\d+)\s+([\d.]+)条\/时\s+send=\s*(\d+)\s+in=\s*(\d+)/);
    if (mm) rows.push({ chat: mm[1], perHour: parseFloat(mm[2]), send: +mm[3], in: +mm[4] });
  }
  return {
    replyRate: grab('① 回复率'),
    heart: grab('② 心流四态'),
    dup: grab('③ 重复回复率'),
    collision: grab('④ 撞名守卫'),
    totalIn: out.match(/message in\s+(\d+)/)?.[1] ?? '?',
    rows,
  };
}

const A = run(a);
const B = run(b);
const loadRaw = (A.totalIn !== '?' && B.totalIn !== '?' && +A.totalIn > 0 && +B.totalIn > 0)
  ? Math.abs(+A.totalIn - +B.totalIn) / Math.max(+A.totalIn, +B.totalIn)
  : null;

const pad = (s, n) => String(s).padEnd(n);
console.log();
console.log(`  A = ${flag} ${a}              B = ${flag} ${b}`);
console.log('  ' + '─'.repeat(66));
console.log(`  ${pad('① 回复率', 16)} A ${pad(A.replyRate, 22)} B ${B.replyRate}`);
console.log(`  ${pad('② 心流四态', 16)} A ${pad(A.heart, 22)} B ${B.heart}`);
console.log(`  ${pad('③ 重复回复率', 16)} A ${pad(A.dup, 22)} B ${B.dup}`);
console.log(`  ${pad('④ 撞名守卫', 16)} A ${pad(A.collision, 22)} B ${B.collision}`);
console.log(`  ${pad('载荷(入站)', 16)} A ${pad(A.totalIn, 22)} B ${B.totalIn}`);
console.log();
console.log('  按群 条/小时（A → B）：');
const chats = [...new Set([...A.rows.map((r) => r.chat), ...B.rows.map((r) => r.chat)])];
for (const c of chats) {
  const ra = A.rows.find((r) => r.chat === c);
  const rb = B.rows.find((r) => r.chat === c);
  const f = (r) => (r ? `${r.perHour.toFixed(1)}条/时(占${(r.send * 100 / Math.max(1, r.in)).toFixed(0)}%)`.padEnd(22) : '(无)'.padEnd(22));
  const arrow = (ra && rb && rb.perHour < ra.perHour * 0.9) ? ' ↓' : (ra && rb && rb.perHour > ra.perHour * 1.1 ? ' ↑' : '');
  console.log(`    ${pad(c, 20)} ${f(ra)} → ${f(rb)}${arrow}`);
}
console.log();
if (loadRaw === null) {
  console.log('  ⚠️ 至少一个窗口没有入站数据（载荷 0 或未量到）——**没得比**。');
  console.log('     空窗口的任何比率都是 0/0，看着像"完美收敛"，其实是没有样本。');
  console.log('     这是 round 8 小样本假象的极端形式。');
} else if (loadRaw > 0.25) {
  console.log(`  ⚠️ 两个窗口载荷差 ${(load * 100).toFixed(0)}%（>25%）——**不许下结论**。`);
  console.log('     load 不同的时候，"回复率降了" 可能只是群里变安静。');
  console.log('     round 9 就吃过这个：两个窗口 in=2204 vs 416。');
  console.log('     ⚠️ 注意：B 是**今天到现在**（如果还没过完，它必然小于 A）。');
  console.log('        想比"完整的两天"，等今天过了 23:00 再跑，或者 --since 取同时长。');
} else {
  console.log(`  ✓ 载荷差 ${(loadRaw * 100).toFixed(0)}%（<=25%）——可以比。`);
}
console.log();
