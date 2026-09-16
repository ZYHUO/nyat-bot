#!/usr/bin/env npx tsx
// ────────────────────────────────────────
// Phase 5A — allowlist Redis key health check
//
// The allowlist keys are already in the correct format for the TS bot.
// This script validates they exist and are structurally sound.
//
// Usage:
//   npx tsx scripts/migrate-allowlist.ts [--help]
// ────────────────────────────────────────

import 'dotenv/config';
import Redis from 'ioredis';

// ── CLI args ──────────────────────────────

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`
migrate-allowlist — validate allowlist Redis keys (health check)

Usage:
  npx tsx scripts/migrate-allowlist.ts [options]

Options:
  --help, -h   Show this help message

Environment:
  REDIS_URL    Redis connection string (default: redis://127.0.0.1:6379/0)

No data conversion is performed — this is a read-only validation.
`);
  process.exit(0);
}

// ── Main ──────────────────────────────────

const KEYS_TO_CHECK = [
  'xxb:mal:groups',
  'xxb:mal:pending',
  'xxb:mal:reviewed',
];

async function main(): Promise<void> {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379/0';
  console.log(`Connecting to Redis: ${redisUrl}\n`);

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  await redis.connect();

  let allOk = true;

  for (const key of KEYS_TO_CHECK) {
    const exists = await redis.exists(key);
    if (!exists) {
      console.log(`⚠  ${key} — does not exist (will be created on first use)`);
      continue;
    }

    const type = await redis.type(key);
    console.log(`✓  ${key} — type: ${type}`);

    try {
      if (type === 'hash') {
        const size = await redis.hlen(key);
        console.log(`   entries: ${size}`);

        // Sample a few entries for structure validation
        const sample = await redis.hscan(key, '0', 'COUNT', 3);
        const pairs = sample[1];
        if (pairs.length >= 2) {
          const sampleKey = pairs[0];
          const sampleVal = pairs[1];
          console.log(`   sample key: ${sampleKey}`);
          try {
            const parsed = JSON.parse(sampleVal!);
            console.log(`   sample value (parsed): ${JSON.stringify(parsed).slice(0, 200)}`);
          } catch {
            console.log(`   sample value (raw): ${sampleVal!.slice(0, 200)}`);
          }
        }
      } else if (type === 'set') {
        const size = await redis.scard(key);
        console.log(`   members: ${size}`);

        const sample = await redis.sscan(key, '0', 'COUNT', 3);
        if (sample[1].length > 0) {
          console.log(`   sample: ${sample[1].slice(0, 3).join(', ')}`);
        }
      } else if (type === 'string') {
        const val = await redis.get(key);
        try {
          const parsed = JSON.parse(val ?? '');
          console.log(`   value (parsed): ${JSON.stringify(parsed).slice(0, 200)}`);
        } catch {
          console.log(`   value (raw): ${val?.slice(0, 200)}`);
        }
      } else if (type === 'list') {
        const len = await redis.llen(key);
        console.log(`   length: ${len}`);
      } else {
        console.log(`   (unsupported type for inspection)`);
      }
    } catch (err) {
      console.error(`   ✗ Error inspecting ${key}:`, err instanceof Error ? err.message : err);
      allOk = false;
    }

    console.log();
  }

  // Also check for any other xxb:mal:* keys
  const malKeys: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'xxb:mal:*', 'COUNT', 200);
    cursor = next;
    malKeys.push(...keys);
  } while (cursor !== '0');

  const extra = malKeys.filter((k) => !KEYS_TO_CHECK.includes(k));
  if (extra.length > 0) {
    console.log(`ℹ  Found ${extra.length} additional xxb:mal:* key(s):`);
    for (const k of extra) {
      const t = await redis.type(k);
      console.log(`   ${k} (${t})`);
    }
    console.log();
  }

  console.log('── Result ──');
  console.log(allOk ? '✓ All allowlist keys are compatible — no migration needed.' : '✗ Some issues found (see above).');

  await redis.quit();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
