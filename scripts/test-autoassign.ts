// 实测 auto-assign: 对 reply/judge/summarize/vision 各会选出什么链
// 跑法: cd /root/xxb-ts && npx tsx scripts/test-autoassign.ts

import { config } from 'dotenv';
config();

process.env.SMART_GROUP_ENABLED = 'true';
process.env.SMART_GROUP_AUTO_ASSIGN = 'true';
process.env.SMART_GROUP_STRATEGY = 'best-latency';

const { initSmartGroup, smartGroupAutoAssign, recordSmartGroupResult } = await import('../src/ai/smart-group.js');
const { getLabels } = await import('../src/ai/labels.js');

await initSmartGroup();

console.log(`\ntotal providers in pool: ${getLabels().size}`);
console.log('\ntier distribution:');
const tiers = new Map<string, number>();
for (const l of getLabels().values()) {
  const t = l.tier ?? 'medium';
  tiers.set(t, (tiers.get(t) ?? 0) + 1);
}
for (const [t, n] of tiers.entries()) console.log(`  ${t}: ${n}`);

for (const usage of ['reply', 'judge', 'summarize', 'vision', 'deep_think', 'reflection']) {
  const chain = await smartGroupAutoAssign(usage);
  console.log(`\n${usage} → [${chain.join(', ')}]`);
}

process.exit(0);
