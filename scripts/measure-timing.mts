// round 107：**接话延迟的三段账**（`npm run measure:timing`）。
//
// round 103-106 诊断出"很难融入话题"是延迟问题，但那些数字只存在于
// commit message 里——下次要看还得重写脚本。这里固化成工具。
//
// 三段（全天）：
//   ① 消息到达 → 心流决策
//   ② 心流决策 → 发送
//   ③ 30s / 5min / 10min 快接率
//
// 基线（09-23）：① median 11.3s p90 23.2s · ② median 19.4s p90 42.3s ·
//               快接 30s 51% / 5min 84% / 10min 89%。
import { createReadStream } from 'node:fs';
import readline from 'node:readline';

const dayArg = process.argv.find((a) => a.startsWith('--day='))?.slice(6);
const DAY = dayArg ?? new Date().toISOString().slice(0, 10);

interface Row { t: number; chat: string; k: string; mid?: number; rp?: number; act?: string; }

const rows: Row[] = [];
const rl = readline.createInterface({ input: createReadStream('logs/app.log') });
await new Promise<void>((res) => {
  rl.on('line', (l: string) => {
    if (!l.startsWith('{')) return;
    let d: any; try { d = JSON.parse(l); } catch { return; }
    if (!d || typeof d !== 'object') return;
    if (new Date(d.time ?? 0).toISOString().slice(0, 10) !== DAY) return;
    const m = String(d.msg ?? '');
    if (m === 'message in' && !d.isBot) rows.push({ t: d.time, chat: String(d.chatId), k: 'i', mid: d.messageId });
    else if (m === 'Heart decision') rows.push({ t: d.time, chat: String(d.chatId), k: 'hd', act: d.act });
    else if (m === 'host sendText' && d.replyTo) rows.push({ t: d.time, chat: String(d.chatId), k: 'o', rp: d.replyTo });
  });
  rl.on('close', () => res());
});

const P = (s: string): string => `  ${s}`;
const stat = (a: number[]): string => {
  if (!a.length) return 'n=0';
  const s = a.slice().sort((x, y) => x - y);
  return `median ${(s[s.length >> 1]! / 1000).toFixed(1)}s  p90 ${(s[Math.floor(s.length * 0.9)]! / 1000).toFixed(1)}s`;
};

// ① 锚点 → 心流决策（reply）
const seg1: number[] = [];
const seg2: number[] = [];
const mid2t: Record<string, number> = {};
for (const r of rows) if (r.k === 'i' && r.mid) mid2t[`${r.chat}:${r.mid}`] = r.t;
for (const r of rows) {
  if (r.k !== 'o' || !r.rp) continue;
  const at = mid2t[`${r.chat}:${r.rp}`];
  if (!at) continue;
  let hd = 0;
  for (let i = rows.indexOf(r) - 1; i >= 0; i--) {
    const q = rows[i]!;
    if (r.t - q.t > 120000) break;
    if (q.k === 'hd' && q.chat === r.chat && q.t >= at) { hd = q.t; break; }
  }
  if (hd) { seg1.push(hd - at); seg2.push(r.t - hd); }
}
// ② 快接率（三个窗口）
const wins = [30_000, 300_000, 600_000];
const hit: Record<number, number> = {};
for (const w of wins) hit[w] = 0;
let anchored = 0;
for (const r of rows) {
  if (r.k !== 'o' || !r.rp) continue;
  anchored++;
  for (const w of wins) {
    for (let i = rows.indexOf(r) + 1; i < rows.length; i++) {
      const q = rows[i]!;
      if (q.t - r.t > w) break;
      if (q.k === 'i' && q.chat === r.chat) { hit[w]!++; break; }
    }
  }
}
console.log(P(`接话延迟（${DAY}）`));
console.log(P(`① 锚点消息 → 心流决策  ${stat(seg1)}   n=${seg1.length}`));
console.log(P(`② 心流决策 → 发送      ${stat(seg2)}   n=${seg2.length}`));
console.log(P(''));
console.log(P('快接率（有人回它这句）：'));
for (const w of wins) {
  const n = hit[w]!;
  console.log(P(`  ${(w / 1000).toFixed(0)}s 内：${n}/${anchored}  ${anchored ? ((100 * n) / anchored).toFixed(0) : 0}%`));
}
console.log(P(''));
console.log(P('基线 09-23：① 11.3s/23.2s · ② 19.4s/42.3s · 快接 51%/84%/89%'));
console.log(P('要对上"融得进"：总延迟压到 20s 内（快接 ~80%）。那是第 3 档的设计选择。'));
process.exit(0);
