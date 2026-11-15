/**
 * Nyat Trench · outcome 存量回填（one-shot, re-runnable）
 *
 * 背景：`recordReply()`（建 pending 条目）此前只在 legacy pipeline 和 proactive tick
 * 里被调，**生产主路径从不建**。于是主路径写出的 self_replies 行生来无法闭合——
 * 实测 1,506 行未结算，其中 91% 发出后 600 秒内明明有入站消息（不是"无人后续"）。
 *
 * 但判定并没有丢：`reply_outcomes` 有 11,850 行（ignored_5_msgs 7538 / user_replied
 * 2327 / user_mentioned_bot 1048 / …）。本脚本按 (chat_id, reply_text) 精确匹配把
 * 它们回填回 self_replies。
 *
 * 诚实性约束（缺一不可）：
 *   - 只填**唯一**匹配；多条命中就跳过，宁可留 unknown 也不猜
 *   - 不动已有 outcome 的行
 *   - 每次运行打印改了哪几行，可审计
 *   - 不碰 cognitive_events（那要另外的因果链，属于 Echo 的职责）
 *
 * 用法：npx tsx scripts/backfill-outcomes.mts [--dry-run]
 */

import { execSync } from 'node:child_process';

const DRY = process.argv.includes('--dry-run');
const DB = process.env.SQLITE_PATH ?? './data/xxb.db';

const SIGNAL_MAP: Record<string, string> = {
  user_replied: 'replied',
  user_mentioned_bot: 'mentioned',
  explicit_positive: 'reacted',
  explicit_negative: 'corrected',
  repair_loop: 'corrected',
  ignored_5_msgs: 'ignored',
  ignored_600s_no_reply: 'ignored',
  ignored_689s_no_reply: 'ignored',
  ignored_1397s_no_reply: 'ignored',
};

function sql(q: string): unknown[] {
  const out = execSync(`sqlite3 -json "${DB}" "${q.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.trim() ? JSON.parse(out) : [];
}

// 待填的行
const pending = sql(`
  SELECT id, chat_id, reply_text, bot_message_id, ts FROM self_replies
  WHERE outcome = 'unknown' AND bot_message_id IS NOT NULL AND bot_message_id > 0
    AND reply_text IS NOT NULL AND TRIM(reply_text) <> ''`) as Array<{
  id: number; chat_id: number; reply_text: string; bot_message_id: number; ts: number;
}>;

console.log(`\n待填行：${pending.length}`);

// 候选判定，按 (chat_id, reply_text) 建索引
const verdicts = sql(`SELECT chat_id, reply_text, signal FROM reply_outcomes`) as Array<{
  chat_id: number; reply_text: string; signal: string;
}>;
const byKey = new Map<string, Array<string>>();
for (const v of verdicts) {
  const k = `${v.chat_id}\u0000${v.reply_text}`;
  const list = byKey.get(k) ?? [];
  list.push(v.signal);
  byKey.set(k, list);
}

let filled = 0;
let ambiguous = 0;
let unmatched = 0;
const samples: string[] = [];

for (const row of pending) {
  const signals = byKey.get(`${row.chat_id}\u0000${row.reply_text}`);
  if (!signals || signals.length === 0) { unmatched += 1; continue; }
  const distinct = [...new Set(signals)];
  if (distinct.length !== 1) { ambiguous += 1; continue; }   // 多条不同判定 → 不猜
  const outcome = SIGNAL_MAP[distinct[0]!];
  if (!outcome) { ambiguous += 1; continue; }
  filled += 1;
  if (samples.length < 8) samples.push(`  chat ${row.chat_id} #${row.bot_message_id} → ${outcome}（${distinct[0]}）`);
  if (!DRY) {
    execSync(
      `sqlite3 "${DB}" "UPDATE self_replies SET outcome='${outcome}', outcome_at=${row.ts + 600} WHERE id=${row.id} AND outcome='unknown'"`,
      { encoding: 'utf8' },
    );
  }
}

console.log(`  唯一命中可填：${filled}`);
console.log(`  多条判定/无法映射（跳过）：${ambiguous}`);
console.log(`  无匹配（判定真的没记）：${unmatched}`);
if (samples.length) console.log('样例：\n' + samples.join('\n'));
console.log(DRY ? '\n[dry-run] 未写库。' : '\n已写库。');
console.log('');
