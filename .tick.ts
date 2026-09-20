// 捕获下一个 pump tick 的看门狗行为：顶格群的 pfull_since 建/清。
import { getRedis } from './src/db/redis.js';
import { writeFileSync } from 'node:fs';
const r = getRedis();
const PINNED = -1003350411234;
let last = await r.get('xxb:tick:lastrun:trench-pump');
for (let i = 0; i < 120; i++) {
  const cur = await r.get('xxb:tick:lastrun:trench-pump');
  if (cur && cur !== last) {
    const p = await r.get('xxb:trench:p:' + PINNED);
    const since = await r.get('xxb:trench:pfull_since:' + PINNED);
    const allKeys = (await r.keys('xxb:trench:pfull_since:*')).length;
    const out = 'TICK ran=' + new Date(Number(cur) * 1000).toISOString() +
      ' pinnedP=' + p + ' pinnedSince=' + (since ?? 'none') + ' totalTimingKeys=' + allKeys;
    writeFileSync('/tmp/tick-watchdog.txt', out + '\\n');
    console.log(out);
    process.exit(0);
  }
  await new Promise((res) => setTimeout(res, 15_000));
}
console.log('TICK timeout');
process.exit(0);
