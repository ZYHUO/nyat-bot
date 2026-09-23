/**
 * round 74：**给"我从日志里 grep 出的数"配一个口径。**
 *
 * Round 73 “审我自己的输入”的续篇：它给 /metrics 加了口径头，
 * 但 logs/app.log 才是重灾区——我每轮都在那里 grep 出一个数，然后当事实用。
 *
 * 那个数可能是：
 *   ① 真值                          → 可以上结论
 *   ② 进程内（重启归零）              → 必须说"这次进程内"
 *   ③ 睡期不触发                       → 必须说"不是 0 而是没机会"
 *   ④ 我 grep 的字段就不对（round 185）      → 必须说"这个字段可能不是它"
 *
 * 所以这个包装强制输出三段：
 *   匹配数 + 时间窗口 + 三句口径（重启次数 / 睡期占比 / 这个数不代表什么）。
 *
 * 用法：
 *   npx tsx scripts/log-count.mts 'rejected task burst' [daysBack]
 *
 * 设计：不自动判断"这个数可以上结论否"——那要知道模式的语义，而这里没有。
 * 只把判断所需的三件事堆到一起，让人（我）自己上结论。
 */
import * as fs from 'node:fs';

const needle = process.argv[2];
const days = Number(process.argv[3] ?? '3');
if (!needle) {
  console.error('usage: npx tsx scripts/log-count.mts <substring> [daysBack]');
  process.exit(2);
}

const sinceMs = Date.now() - days * 24 * 3600 * 1000;
let hits = 0;
let lines = 0;
const perDay = new Map<string, number>();
let firstTs = 0;
let lastTs = 0;

const rl = (await import('node:readline')).default.createInterface({
  input: fs.createReadStream('logs/app.log'),
});
await new Promise<void>(function (res) {
  rl.on('line', function (l: string) {
    lines++;
    if (l.indexOf(needle) < 0) return;
    if (!l.startsWith('{')) return;
    let d: any;
    try { d = JSON.parse(l); } catch { return; }
    if (!d || typeof d !== 'object') return;
    const t = d.time ?? 0;
    if (t < sinceMs) return;
    hits++;
    const day = new Date(t).toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    if (!firstTs) firstTs = t;
    lastTs = t;
  });
  rl.on('close', function () { res(); });
});

// 重启次数（进程内状态每次重置）
let restarts = 0;
const rl2 = (await import('node:readline')).default.createInterface({
  input: fs.createReadStream('logs/app.log'),
});
await new Promise<void>(function (res) {
  rl2.on('line', function (l: string) {
    if (l.indexOf('Bot started (polling)') < 0) return;
    if (!l.startsWith('{')) return;
    let d: any;
    try { d = JSON.parse(l); } catch { return; }
    if (d && (d.time ?? 0) >= sinceMs) restarts++;
  });
  rl2.on('close', function () { res(); });
});

const dayList = [...perDay.entries()].sort().map(([d, n]) => `${d}×${n}`).join('  ');

console.log('');
console.log(`匹配 "${needle}"（近 ${days} 天）: ${hits} 次`);
if (dayList) console.log(`  按天: ${dayList}`);
console.log('');
console.log('口径（读这个数之前先看这三句）：');
console.log(`  · 窗口内重启 ${restarts} 次 —— 进程内状态每次清零，本数若来自进程内则不可跨重启相加`);
console.log(`  · 该数的触发条件在睡期可能不成立 —— 0 或很小 ≠ 没发生，可能是没机会`);
console.log('  · 本工具只做子串匹配，不判断语义 —— 若你 grep 的字符串出现在 err.message');
console.log('    而不是 msg 里（round 185 就这么错过一次 All labels exhausted），这个数会偏低');
if (hits > 0) {
  console.log(`  · 首末命中: ${new Date(firstTs).toISOString().slice(0, 16)} → ${new Date(lastTs).toISOString().slice(0, 16)}`);
}
console.log('');
