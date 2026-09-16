import 'dotenv/config';
const { getRecent } = await import('/root/xxb-ts/src/pipeline/context/manager.js');
const msgs = await getRecent(-1002450361141, 400);
const botLens: number[] = [], humanLens: number[] = [];
for (const m of msgs) {
  const t = (m.textContent || '').trim();
  if (!t || t.startsWith('[')) continue;
  if (m.role === 'assistant') botLens.push(t.length);
  else if (m.uid > 0) humanLens.push(t.length);
}
const labels = ['≤8字', '9-20', '21-40', '41-80', '>80'];
const dist = (arr: number[]) => {
  const buckets = [0, 0, 0, 0, 0];
  for (const l of arr) buckets[l <= 8 ? 0 : l <= 20 ? 1 : l <= 40 ? 2 : l <= 80 ? 3 : 4]!++;
  return buckets.map((b, i) => labels[i] + ':' + (b / arr.length * 100).toFixed(0) + '%').join(' ');
};
const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1)).toFixed(1);
console.log('真人', humanLens.length, '条:', dist(humanLens), '| 平均', avg(humanLens), '字');
console.log('bot ', botLens.length, '条:', dist(botLens), '| 平均', avg(botLens), '字');
process.exit(0);
