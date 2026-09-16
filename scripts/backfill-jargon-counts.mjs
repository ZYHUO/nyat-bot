#!/usr/bin/env node
// G1 一次性回填:存量黑话(全部卡在 count=1)对各群最近上下文重新计数。
// 用法:node scripts/backfill-jargon-counts.mjs(服务可在线,SQLite WAL)
import Database from 'better-sqlite3';
import Redis from 'ioredis';

const db = new Database('./data/xxb.db');
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379/5');

const chats = db.prepare('SELECT DISTINCT chat_id FROM jargons').all().map((r) => r.chat_id);
console.log(`chats with jargons: ${chats.length}`);

const now = Math.floor(Date.now() / 1000);
const bump = db.prepare('UPDATE jargons SET count = count + ?, updated_at = ? WHERE chat_id = ? AND content = ?');

let totalBumped = 0;
for (const chatId of chats) {
  const raw = await redis.lrange(`xxb:ctx:${chatId}`, -600, -1);
  const texts = [];
  for (const item of raw) {
    try {
      const e = JSON.parse(item);
      if (e.role !== 'assistant' && !e.isBot && e.textContent) texts.push(e.textContent);
    } catch { /* skip */ }
  }
  if (texts.length === 0) continue;

  const rows = db.prepare(
    'SELECT content FROM jargons WHERE chat_id = ? AND length(content) BETWEEN 2 AND 12',
  ).all(chatId);

  let bumped = 0;
  const tx = db.transaction(() => {
    for (const { content } of rows) {
      let hits = 0;
      for (const t of texts) if (t.includes(content)) hits++;
      if (hits > 0) {
        bump.run(Math.min(hits, 6), now, chatId, content); // 回填上限放宽到 6
        bumped++;
      }
    }
  });
  tx();
  totalBumped += bumped;
  console.log(`chat ${chatId}: ${texts.length} msgs scanned, ${bumped}/${rows.length} terms reinforced`);
}

const dist = db.prepare("SELECT count, COUNT(*) AS n FROM jargons GROUP BY count ORDER BY count DESC LIMIT 8").all();
console.log('count distribution after backfill:', JSON.stringify(dist));
console.log(`total terms reinforced: ${totalBumped}`);
await redis.quit();
db.close();
