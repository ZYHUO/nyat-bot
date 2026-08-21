import 'dotenv/config';
const { getRecent } = await import('/root/xxb-ts/src/pipeline/context/manager.js');
const cutoff = Date.now() / 1000 - 48 * 3600;
const chats = [-1002450361141, -1003184176508, -1003579270814, -1003778222462, -1003022727627, 6251541967];
const out: string[] = [];
for (const c of chats) {
  try {
    const msgs = await getRecent(c, 200);
    for (const m of msgs) {
      if (m.role === 'assistant' && m.timestamp > cutoff) {
        out.push(`${new Date(m.timestamp * 1000).toISOString().slice(5, 16)} [${String(c).slice(-6)}] ${(m.textContent || '[non-text]').slice(0, 90)}`);
      }
    }
  } catch (e) { console.log('err', c, String(e).slice(0, 80)); }
}
out.sort();
console.log(`近48h bot 发言 ${out.length} 条:`);
for (const l of out.slice(-35)) console.log(l);
process.exit(0);
