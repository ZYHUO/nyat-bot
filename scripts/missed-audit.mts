import 'dotenv/config';
import { readFileSync } from 'node:fs';

// 近 24h heart pass 的 messageId+chatId 样本
const cutoff = Date.now() - 24 * 3600 * 1000;
const passes: { chatId: number; messageId: number; why: string; t: number }[] = [];
for (const line of readFileSync('logs/app.log', 'utf8').split('\n')) {
  const m = line.match(/"time":(\d+)/);
  if (!m || Number(m[1]) < cutoff) continue;
  if (line.includes('"Meta heart: pass"')) {
    const cid = line.match(/"chatId":(-?\d+)/);
    const mid = line.match(/"messageId":(\d+)/);
    const why = line.match(/"why":"((?:[^"\\]|\\.)*)"/);
    if (cid && mid) passes.push({ chatId: Number(cid[1]), messageId: Number(mid[1]), why: why?.[1] ?? '', t: Number(m[1]) });
  }
}
console.log('heart pass 样本:', passes.length);

const { getRecent } = await import('/root/xxb-ts/src/pipeline/context/manager.js');
const { getBotIdentity } = await import('/root/xxb-ts/src/bot/bot.js');
const nicks = getBotIdentity().nicknames;
console.log('nicknames:', nicks.join('/'));

let shouldMiss = 0;
const samples: string[] = [];
const byChat = new Map<number, typeof passes>();
for (const p of passes) {
  const arr = byChat.get(p.chatId) ?? [];
  arr.push(p);
  byChat.set(p.chatId, arr);
}
for (const [chatId, arr] of byChat) {
  const ctx = await getRecent(chatId, 600);
  for (const p of arr.slice(0, 40)) {
    const msg = ctx.find((m) => m.messageId === p.messageId);
    if (!msg) continue;
    const text = msg.textContent ?? '';
    const called = nicks.some((n) => n && text.includes(n));
    const replyBot = msg.replyTo?.uid != null && String(msg.replyTo.uid) === String(getBotIdentity().uid);
    if (called || replyBot) {
      shouldMiss++;
      if (samples.length < 8) samples.push(`[${p.why.slice(0, 30)}] ${text.slice(0, 60)}`);
    }
  }
}
console.log('其中冲 bot 来（该被 missed 记录）的:', shouldMiss);
for (const s of samples) console.log('  -', s);
process.exit(0);
