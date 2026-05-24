// ────────────────────────────────────────
// BotInteractionTracker — SQLite-based
// Port of PHP BotInteractionTracker (JSONL → SQLite)
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';

const MAX_BOTS_PER_GROUP = 20;
const MAX_RAW_RECORDS = 1000;
const TEXT_MAX_LENGTH = 500;
const DIGEST_THRESHOLD = 50;
const DIGEST_INTERVAL = 86400; // 1 day
const INJECT_MAX_BOTS = 2;
const INJECT_MAX_CHARS = 500;

let _instance: BotInteractionTracker | null = null;

export function getBotTracker(): BotInteractionTracker | null {
  return _instance;
}

export function initBotTracker(): BotInteractionTracker {
  _instance = new BotInteractionTracker();
  return _instance;
}

export class BotInteractionTracker {
  recordInteraction(
    chatId: number,
    interaction: {
      ts: number;
      type: string;
      bot: string;
      uid?: number;
      text: string;
      mid: number;
      replyToMid?: number;
    },
  ): void {
    const db = getDb();
    const botUsername = interaction.bot.replace(/^@/, '');
    if (!botUsername) return;

    try {
      const text = interaction.text.slice(0, TEXT_MAX_LENGTH);

      db.transaction(() => {
        // Check bot count limit per group — atomic with the insert
        const botCount = db
          .prepare('SELECT COUNT(DISTINCT bot_username) as cnt FROM bot_interactions WHERE chat_id = ?')
          .get(chatId) as { cnt: number } | undefined;

        if ((botCount?.cnt ?? 0) >= MAX_BOTS_PER_GROUP) {
          const exists = db
            .prepare('SELECT 1 FROM bot_interactions WHERE chat_id = ? AND bot_username = ? LIMIT 1')
            .get(chatId, botUsername);
          if (!exists) return;
        }

        db.prepare(
          `INSERT INTO bot_interactions (chat_id, bot_username, ts, type, uid, text, mid, reply_to_mid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          chatId,
          botUsername,
          interaction.ts,
          interaction.type,
          interaction.uid ?? null,
          text,
          interaction.mid,
          interaction.replyToMid ?? null,
        );

        // Enforce FIFO: delete oldest if exceeds max
        db.prepare(
          `DELETE FROM bot_interactions
           WHERE id IN (
             SELECT id FROM bot_interactions
             WHERE chat_id = ? AND bot_username = ?
             ORDER BY id ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM bot_interactions WHERE chat_id = ? AND bot_username = ?) - ?)
           )`,
        ).run(chatId, botUsername, chatId, botUsername, MAX_RAW_RECORDS);
      })();
    } catch (err) {
      logger.warn({ err, chatId, botUsername }, 'BotInteractionTracker: record failed');
    }
  }

  getDigest(chatId: number, botUsername: string): string {
    const row = getDb()
      .prepare('SELECT digest_md FROM bot_digests WHERE chat_id = ? AND bot_username = ?')
      .get(chatId, botUsername.replace(/^@/, '')) as { digest_md: string } | undefined;
    return row?.digest_md ?? '';
  }

  getGlobalDigest(botUsername: string): string {
    const row = getDb()
      .prepare('SELECT digest_md FROM bot_global_digests WHERE bot_username = ?')
      .get(botUsername.replace(/^@/, '')) as { digest_md: string } | undefined;
    return row?.digest_md ?? '';
  }

  listKnownBots(chatId: number): string[] {
    const rows = getDb()
      .prepare('SELECT DISTINCT bot_username FROM bot_interactions WHERE chat_id = ?')
      .all(chatId) as Array<{ bot_username: string }>;
    return rows.map((r) => r.bot_username);
  }

  needsDigest(chatId: number, botUsername: string): boolean {
    const bot = botUsername.replace(/^@/, '');
    const meta = this.loadMeta(chatId, bot);
    // Query actual count from bot_interactions (raw_count in meta is only updated after digest)
    const actual = getDb()
      .prepare('SELECT COUNT(*) as cnt FROM bot_interactions WHERE chat_id = ? AND bot_username = ?')
      .get(chatId, bot) as { cnt: number };
    const undigested = actual.cnt - meta.digestedCount;
    if (undigested >= DIGEST_THRESHOLD) return true;
    if (undigested > 0 && now() - meta.lastDigestTs >= DIGEST_INTERVAL) return true;
    return false;
  }

  getRawForDigest(chatId: number, botUsername: string, limit = 200): Array<Record<string, unknown>> {
    const meta = this.loadMeta(chatId, botUsername);
    return getDb()
      .prepare(
        `SELECT * FROM bot_interactions
         WHERE chat_id = ? AND bot_username = ?
         ORDER BY id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(chatId, botUsername.replace(/^@/, ''), limit, meta.digestedCount) as Array<Record<string, unknown>>;
  }

  saveDigest(chatId: number, botUsername: string, markdown: string): void {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO bot_digests (chat_id, bot_username, digest_md, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(chatId, botUsername.replace(/^@/, ''), markdown, now());

    this.updateMetaAfterDigest(chatId, botUsername);
  }

  saveGlobalDigest(botUsername: string, markdown: string): void {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO bot_global_digests (bot_username, digest_md, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(botUsername.replace(/^@/, ''), markdown, now());
  }

  getKnowledgeForReply(
    chatId: number,
    recentContext: Array<{ isBot?: boolean; botUsername?: string }>,
  ): string {
    const mentionedBots = new Set<string>();
    for (const msg of recentContext) {
      if (msg.isBot && msg.botUsername) {
        mentionedBots.add(msg.botUsername);
      }
    }

    if (mentionedBots.size === 0) return '';

    const parts: string[] = [];
    let count = 0;
    for (const botUname of mentionedBots) {
      if (count >= INJECT_MAX_BOTS) break;
      let digest = this.getDigest(chatId, botUname);
      if (!digest) digest = this.getGlobalDigest(botUname);
      if (digest) {
        const safe = digest
          .replace(/<response>/g, '＜response＞')
          .replace(/<\/response>/g, '＜/response＞')
          .replace(/<reply_content>/g, '＜reply_content＞')
          .replace(/<\/reply_content>/g, '＜/reply_content＞');
        parts.push(`--- Bot 知识(@${botUname}) ---\n${safe.slice(0, INJECT_MAX_CHARS)}`);
        count++;
      }
    }

    return parts.join('\n\n');
  }

  handleToolQuery(chatId: number, query: string): string {
    const q = query.trim();
    if (!q || q.toLowerCase() === 'list') {
      const bots = this.listKnownBots(chatId);
      if (bots.length === 0) return '当前群组暂无已知 bot 记录。';
      return '已知 bot 列表:\n' + bots.map((b) => `- @${b}`).join('\n');
    }

    const botUsername = q.replace(/^@/, '');
    let digest = this.getDigest(chatId, botUsername);
    if (!digest) digest = this.getGlobalDigest(botUsername);
    return digest || `暂无关于 @${botUsername} 的知识记录。`;
  }

  private loadMeta(
    chatId: number,
    botUsername: string,
  ): { rawCount: number; digestedCount: number; lastDigestTs: number } {
    const row = getDb()
      .prepare(
        'SELECT raw_count, digested_count, last_digest_ts FROM bot_interaction_meta WHERE chat_id = ? AND bot_username = ?',
      )
      .get(chatId, botUsername.replace(/^@/, '')) as
      | { raw_count: number; digested_count: number; last_digest_ts: number }
      | undefined;

    return {
      rawCount: row?.raw_count ?? 0,
      digestedCount: row?.digested_count ?? 0,
      lastDigestTs: row?.last_digest_ts ?? 0,
    };
  }

  private updateMetaAfterDigest(chatId: number, botUsername: string): void {
    const bot = botUsername.replace(/^@/, '');
    const count = getDb()
      .prepare('SELECT COUNT(*) as cnt FROM bot_interactions WHERE chat_id = ? AND bot_username = ?')
      .get(chatId, bot) as { cnt: number };

    getDb()
      .prepare(
        `INSERT OR REPLACE INTO bot_interaction_meta (chat_id, bot_username, raw_count, digested_count, last_digest_ts)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(chatId, bot, count.cnt, count.cnt, now());
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
