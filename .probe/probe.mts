import { getUsage, getLabels } from '../src/ai/labels.js';
import { env } from '../src/env.js';
console.log('ARTIST_USAGE =', JSON.stringify(env().ARTIST_USAGE));
console.log('labels:', [...getLabels().keys()].join(','));
for (const u of ['artist','reply','vision']) {
  try { console.log(u, JSON.stringify(getUsage(u))); } catch (e) { console.log(u, 'THROWS:', (e as Error).message); }
}
