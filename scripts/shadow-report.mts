// Phase 2.3 analysis: join ingress shadow verdicts with what the live path did.
// Answers the question the rewrite must justify: when the gates stayed silent,
// did a single decision want to speak?
import Database from 'better-sqlite3';
import { env } from '../src/env.js';

// Read the same DB the service uses rather than a hardcoded absolute path.
const db = new Database(env().SQLITE_PATH, { readonly: true });

const shadow = db.prepare(
  `SELECT fact_json, occurred_at, chat_id FROM cognitive_events
   WHERE dedupe_key LIKE 'shadow-ingress:%' ORDER BY occurred_at DESC LIMIT 500`,
).all() as Array<{ fact_json: string; occurred_at: number; chat_id: number }>;

const liveRows = db.prepare(
  `SELECT fact_json FROM cognitive_events WHERE dedupe_key LIKE 'shadow-live:%'`,
).all() as Array<{ fact_json: string }>;
const liveByMessage = new Map<number, string>();
for (const r of liveRows) {
  const f = JSON.parse(r.fact_json) as { messageId: number; outcome: string };
  liveByMessage.set(f.messageId, f.outcome);
}

type Bucket = { total: number; shadowSpeak: number; shadowSilent: number; shadowWait: number; shadowFailed: number };
const byLive: Record<string, Bucket> = {};
let noLiveRecord = 0;
const disagreements: string[] = [];

for (const row of shadow) {
  const f = JSON.parse(row.fact_json) as { messageId: number; shadowVerdict: string; shadowWhy: string };
  const live = liveByMessage.get(f.messageId);
  if (!live) { noLiveRecord++; continue; }
  const b = (byLive[live] ??= { total: 0, shadowSpeak: 0, shadowSilent: 0, shadowWait: 0, shadowFailed: 0 });
  b.total++;
  if (f.shadowVerdict === 'speak') b.shadowSpeak++;
  else if (f.shadowVerdict === 'silent') b.shadowSilent++;
  else if (f.shadowVerdict === 'wait') b.shadowWait++;
  else b.shadowFailed++;
  // The interesting case: the gates dropped it, but the shadow wanted to speak.
  if ((live === 'silent' || live === 'intercepted') && f.shadowVerdict === 'speak') {
    disagreements.push(`msg ${f.messageId} (live=${live}) shadow 想说：${f.shadowWhy}`);
  }
}

console.log('=== 影子 vs 实盘 ===');
console.log(`影子样本 ${shadow.length}，其中能对上实盘结果的 ${shadow.length - noLiveRecord}，未对上 ${noLiveRecord}`);
console.log();
for (const [live, b] of Object.entries(byLive)) {
  console.log(`实盘 ${live.padEnd(12)} 共 ${String(b.total).padStart(4)}：影子想说 ${b.shadowSpeak} · 不说 ${b.shadowSilent} · 等待 ${b.shadowWait} · 失败 ${b.shadowFailed}`);
}
console.log();
console.log(`=== 关键分歧：闸门拦掉了，但影子想说（${disagreements.length} 条）===`);
for (const d of disagreements.slice(0, 15)) console.log('  ', d);
if (disagreements.length === 0) console.log('  （暂无）');
