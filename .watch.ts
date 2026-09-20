// 醒来守望：每 30 秒查一次 lastphase，一旦翻转就抓取完整现场并写盘，然后退出。
import { getRedis } from './src/db/redis.js';
import { appendFileSync } from 'node:fs';
const r = getRedis();
const KEY = 'xxb:trench:lastphase';
for (let i = 0; i < 240; i++) {           // 最多守 2 小时
  const p = await r.get(KEY);
  if (p && p !== 'sleeping') {
    const snap: Record<string, unknown> = { wokeAt: new Date().toISOString(), phase: p };
    try {
      const keys = await r.keys('xxb:trench:p:*');
      const ps: Record<string, string | null> = {};
      for (const k of keys) ps[k.replace('xxb:trench:p:', '')] = await r.get(k);
      snap.pressure = ps;
      const dk = await r.keys('xxb:trench:owed:*');
      const debts: Record<string, number> = {};
      for (const k of dk) debts[k.replace('xxb:trench:owed:', '')] = await r.hlen(k);
      snap.debtGroups = Object.keys(debts).length;
    } catch { /* 快照尽力而为 */ }
    appendFileSync('/tmp/wake-snapshot.json', JSON.stringify(snap) + '\\n');
    console.log('WATCH woke phase=' + p);
    process.exit(0);
  }
  await new Promise((res) => setTimeout(res, 30_000));
}
console.log('WATCH timeout');
process.exit(0);
