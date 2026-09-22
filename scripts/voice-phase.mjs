#!/usr/bin/env node
/**
 * `npm run voice:phase` —— 一句话：现在该不该量心流行为。
 *
 * 为什么要有：
 *   这个会话在 awake 窗口前空转了 6 轮（round 14-19），每轮都把夜间数字
 *   当成结论。cron（round 30）解决了"该量的那天有数"，但**实时问一句**
 *   "我现在该量吗"还是要人肉对 UTC/北京/`daySchedule()`——round 24 我为此
 *   连错三次。
 *
 * 它只读、不决策、不写字。退出码：
 *   0 = awake 段，可以量
 *   1 = nap 或 night 段，量了也不算白天口径
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

const NODE = '/opt/node22/bin';

/** 跑一段 tsx（写临时文件——`tsx -e` 不吃多行 await）。 */
function tsx(code) {
  const tmp = '.voice-phase-probe.mts';
  fs.writeFileSync(tmp, code);
  const out = execFileSync('npx', ['tsx', tmp], {
    encoding: 'utf8',
    timeout: 150_000,
    env: { ...process.env, PATH: NODE + ':' + (process.env.PATH ?? '') },
    cwd: process.cwd(),
  });
  fs.rmSync(tmp, { force: true });
  return out.trim();
}const now = tsx("console.log(String(Date.now()))");
const sched = JSON.parse(tsx([
  "import { daySchedule } from './src/tracking/life-state.js';",
  "const bj = new Date(Date.now() + 8*3600*1000);",
  "const d = daySchedule(bj.toISOString().slice(0,10));",
  "console.log(JSON.stringify({ date: bj.toISOString().slice(0,10), wakeMin: d.wakeMin, sleepMin: d.sleepMin, napStart: d.napStart, napEnd: d.napEnd }));",
].join('\n')));

const bj = new Date(Number(now) + 8 * 3600_000);
const mins = bj.getUTCHours() * 60 + bj.getUTCMinutes();
const f = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

let phase, why, ok;
if (mins < sched.wakeMin) { phase = 'night'; why = `还没到起床点 ${f(sched.wakeMin)}`; ok = false; }
else if (mins >= sched.sleepMin) { phase = 'night'; why = `已过就寝 ${f(sched.sleepMin)}`; ok = false; }
else if (mins >= sched.napStart && mins < sched.napEnd) { phase = 'nap'; why = `午睡 ${f(sched.napStart)}-${f(sched.napEnd)}`; ok = false; }
else { phase = 'awake'; why = `${f(sched.wakeMin)}-${f(sched.sleepMin)} 扣掉 ${f(sched.napStart)}-${f(sched.napEnd)}`; ok = true; }

console.log();
console.log(`  现在  北京 ${bj.toISOString().slice(11, 16)}（UTC ${new Date(Number(now)).toISOString().slice(11, 16)}）`);
console.log(`  相    ${phase}`);
console.log(`   awake 段 ${why}`);
console.log();
if (ok) {
  console.log('  ✓ 可以量。npm run measure:voice -- --since ' + f(sched.wakeMin - 480 + 1440).slice(0, 5));
  console.log('    （那是 UTC 的起床点减 8 小时；跨天就改日期）');
} else {
  console.log('  ✗ 现在量到的任何"心流行为"结论都不适用于白天。');
  console.log('    metaSleepGate 会静默掉绝大多数被动消息（⑤睡眠门那一行）。');
}
console.log();
process.exit(ok ? 0 : 1);
