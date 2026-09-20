// 醒来自动分析：检测到相位翻转 → 抓快照 → 跑 wakeup-check + canary → 全部写盘。
import { getRedis } from './src/db/redis.js';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const r = getRedis();
const KEY = 'xxb:trench:lastphase';
let woke = false;
for (let i = 0; i < 300; i++) {
  const p = await r.get(KEY);
  if (p && p !== 'sleeping') { woke = true; break; }
  await new Promise((res) => setTimeout(res, 30_000));
}
if (!woke) { console.log('AUTO timeout'); process.exit(0); }

const out: string[] = [];
out.push('=== WAKE DETECTED ' + new Date().toISOString() + ' phase=' + (await r.get(KEY)) + ' ===');
// 快照
const ps: Record<string, string | null> = {};
for (const k of await r.keys('xxb:trench:p:*')) ps[k.replace('xxb:trench:p:', '')] = await r.get(k);
out.push('P: ' + JSON.stringify(ps));
const dk = await r.keys('xxb:trench:owed:*');
const debts: Record<string, number> = {};
for (const k of dk) debts[k.replace('xxb:trench:owed:', '')] = await r.hlen(k);
out.push('DEBT groups=' + Object.keys(debts).length + ' ' + JSON.stringify(debts));

for (const [name, cmd] of [['wakeup-check', 'npx tsx scripts/wakeup-check.mts 3'], ['canary', 'npx tsx scripts/trench-canary.mts 1']] as Array<[string,string]>) {
  try { out.push('--- ' + name + ' ---\\n' + execSync(cmd, { encoding: 'utf8', timeout: 300000 }).toString()); }
  catch (e) { out.push('--- ' + name + ' FAILED --- ' + String(e).slice(0, 200)); }
}
writeFileSync('/tmp/wake-analysis.txt', out.join('\\n'));
console.log('AUTO done, wrote /tmp/wake-analysis.txt');
process.exit(0);
