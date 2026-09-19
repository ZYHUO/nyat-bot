import { readTrench, P_MAX } from './src/nyatos/trench.js';
import { getRedis } from './src/db/redis.js';
const C = -999888777;
await getRedis().set('xxb:trench:p:' + C, String(P_MAX));
const r = await readTrench(C);
console.log('VERIFY P_MAX=' + P_MAX + ' theta=' + r.theta + ' rate=' + r.rate);
await getRedis().del('xxb:trench:p:' + C);
