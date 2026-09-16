#!/usr/bin/env npx tsx
// ────────────────────────────────────────
// Phase 5A — migrate Redis context from PHP → TS format
//
// Usage:
//   npx tsx scripts/migrate-context.ts [--dry-run] [--dual-write] [--help]
// ────────────────────────────────────────

import 'dotenv/config';
import Redis from 'ioredis';

// ── CLI args ──────────────────────────────

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`
migrate-context — migrate Redis chat context from PHP to TS format

Usage:
  npx tsx scripts/migrate-context.ts [options]

Options:
  --dry-run      Count keys and show a sample conversion without writing
  --dual-write   Also write the converted data back to the PHP key (rollback compat)
  --help, -h     Show this help message

Environment:
  REDIS_URL      Redis connection string (default: redis://127.0.0.1:6379/0)
`);
  process.exit(0);
}

const DRY_RUN = args.has('--dry-run');
const DUAL_WRITE = args.has('--dual-write');

// ── PHP → TS message conversion ──────────

interface PhpMessage {
  role: string;
  uid: number;
  username: string;
  full_name: string;
  timestamp: number;
  message_id: number;
  text_content: string;
  caption_content: string;
  reply_to: { uid: number; full_name: string; text: string; content_message_id?: number } | null;
  is_forwarded: boolean;
  [key: string]: unknown; // extra fields from PHP
}

interface TsMessage {
  role: string;
  uid: number;
  username: string;
  fullName: string;
  timestamp: number;
  messageId: number;
  textContent: string;
  captionContent?: string;
  replyTo?: { messageId: number; uid: number; fullName: string; textSnippet: string };
  isForwarded: boolean;
}

function convertMessage(php: PhpMessage): TsMessage {
  const ts: TsMessage = {
    role: php.role,
    uid: php.uid,
    username: php.username ?? '',
    fullName: php.full_name ?? '',
    timestamp: php.timestamp,
    messageId: php.message_id,
    textContent: php.text_content ?? '',
    isForwarded: Boolean(php.is_forwarded),
  };

  if (php.caption_content) {
    ts.captionContent = php.caption_content;
  }

  if (php.reply_to) {
    ts.replyTo = {
      messageId: php.reply_to.content_message_id ?? 0,
      uid: php.reply_to.uid,
      fullName: php.reply_to.full_name ?? '',
      textSnippet: php.reply_to.text ?? '',
    };
  }

  return ts;
}

// ── Main ──────────────────────────────────

const PHP_PREFIX = 'context_chat_';
const TS_PREFIX = 'xxb:ctx:';

async function main(): Promise<void> {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379/0';
  console.log(`Connecting to Redis: ${redisUrl}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${DUAL_WRITE ? ' + dual-write' : ''}\n`);

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  await redis.connect();

  // Scan for all PHP context keys
  const phpKeys: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PHP_PREFIX}*`, 'COUNT', 200);
    cursor = next;
    phpKeys.push(...keys);
  } while (cursor !== '0');

  console.log(`Found ${phpKeys.length} PHP context key(s)\n`);

  if (phpKeys.length === 0) {
    console.log('Nothing to migrate.');
    await redis.quit();
    return;
  }

  let converted = 0;
  let totalMessages = 0;
  let errors = 0;
  let sampleShown = false;

  for (const phpKey of phpKeys) {
    const chatIdStr = phpKey.slice(PHP_PREFIX.length);
    const tsKey = TS_PREFIX + chatIdStr;

    try {
      // PHP stores context as a Redis string (JSON array) or a Redis list
      const keyType = await redis.type(phpKey);
      let rawMessages: string[];

      if (keyType === 'string') {
        // PHP format: single string containing a JSON array
        const raw = await redis.get(phpKey);
        if (!raw) continue;
        try {
          const arr = JSON.parse(raw) as PhpMessage[];
          rawMessages = arr.map((m) => JSON.stringify(m));
        } catch {
          console.error(`Failed to parse JSON string for ${phpKey}`);
          errors++;
          continue;
        }
      } else if (keyType === 'list') {
        rawMessages = await redis.lrange(phpKey, 0, -1);
      } else {
        console.warn(`Unexpected key type '${keyType}' for ${phpKey}, skipping`);
        continue;
      }

      if (rawMessages.length === 0) continue;

      const tsMessages: TsMessage[] = [];
      for (const raw of rawMessages) {
        try {
          const phpMsg = JSON.parse(raw) as PhpMessage;
          tsMessages.push(convertMessage(phpMsg));
        } catch {
          // Skip unparseable messages
          errors++;
        }
      }

      if (DRY_RUN) {
        if (!sampleShown && tsMessages.length > 0) {
          console.log('── Sample conversion ──');
          console.log('PHP key:', phpKey);
          console.log('TS key: ', tsKey);
          console.log(`Messages: ${rawMessages.length} → ${tsMessages.length}`);
          console.log('\nFirst PHP message:');
          console.log(JSON.stringify(JSON.parse(rawMessages[0]!), null, 2).slice(0, 500));
          console.log('\nConverted TS message:');
          console.log(JSON.stringify(tsMessages[0], null, 2));
          console.log('──────────────────────\n');
          sampleShown = true;
        }
        totalMessages += tsMessages.length;
        converted++;
        continue;
      }

      // Write TS format to new key (as a Redis list)
      const pipeline = redis.pipeline();
      pipeline.del(tsKey);
      for (const msg of tsMessages) {
        pipeline.rpush(tsKey, JSON.stringify(msg));
      }

      if (DUAL_WRITE) {
        // Preserve original PHP-format data in PHP key (leave untouched for rollback)
        // Only TS key gets the converted format
      }

      await pipeline.exec();
      totalMessages += tsMessages.length;
      converted++;

      if (converted % 100 === 0) {
        console.log(`  ... ${converted} / ${phpKeys.length} keys processed`);
      }
    } catch (err) {
      errors++;
      console.error(`Error migrating ${phpKey}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log('\n── Summary ──');
  console.log(`Total PHP keys:   ${phpKeys.length}`);
  console.log(`Converted:        ${converted}`);
  console.log(`Total messages:   ${totalMessages}`);
  console.log(`Errors:           ${errors}`);
  if (DRY_RUN) console.log('\n(dry run — no data written)');

  await redis.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
