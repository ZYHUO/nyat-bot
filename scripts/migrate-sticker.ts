#!/usr/bin/env npx tsx
// ────────────────────────────────────────
// Phase 5A — migrate PHP file-based sticker knowledge → TS SQLite
//
// Usage:
//   npx tsx scripts/migrate-sticker.ts [--dry-run] [--help]
// ────────────────────────────────────────

import 'dotenv/config';
import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

// ── CLI args ──────────────────────────────

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log(`
migrate-sticker — migrate PHP sticker knowledge to TS SQLite

Usage:
  npx tsx scripts/migrate-sticker.ts [options]

Options:
  --dry-run    Parse files and report counts without writing to the database
  --help, -h   Show this help message

Environment:
  SQLITE_PATH             Path to SQLite database (default: ./data/xxb.db)

Paths (hardcoded):
  PHP sticker memory:     /root/xxb/storage/sticker_memory/
  PHP sticker assets:     /root/xxb/storage/sticker_assets/
`);
  process.exit(0);
}

const DRY_RUN = args.has('--dry-run');

// ── PHP paths ────────────────────────────

const PHP_MEMORY_DIR = '/root/xxb/storage/sticker_memory';
const PHP_ASSETS_DIR = '/root/xxb/storage/sticker_assets';
const ITEMS_DIR = resolve(PHP_MEMORY_DIR, 'items');
const MARKDOWN_DIR = resolve(PHP_MEMORY_DIR, 'markdown');

// ── Markdown parser ──────────────────────

interface ParsedMarkdown {
  description: string;
  emotionTags: string[];
}

function parseMarkdown(content: string): ParsedMarkdown {
  const lines = content.split('\n');
  let description = '';
  let emotionTags: string[] = [];

  let currentSection = '';
  const descParts: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('## ')) {
      currentSection = trimmed.slice(3).trim().toLowerCase();
      continue;
    }

    if (currentSection === 'visual summary' || currentSection === 'tone summary') {
      if (trimmed) {
        descParts.push(trimmed);
      }
    }

    if (currentSection === 'emotion tags') {
      const match = /^-\s+(.+)$/.exec(trimmed);
      if (match?.[1]) {
        emotionTags.push(match[1].trim().toLowerCase());
      }
    }
  }

  description = descParts.join('\n');
  return { description, emotionTags };
}

// ── Asset path mapping ───────────────────

function mapAssetPath(
  phpPath: string | null | undefined,
  kind: 'raw' | 'preview',
): string | null {
  if (!phpPath) return null;

  // Keep existing absolute paths as-is (they point to the shared filesystem)
  // The TS bot can read them directly
  if (existsSync(phpPath)) return phpPath;

  // Fallback: try constructing from the file_unique_id
  return null;
}

// ── PHP item structure ───────────────────

interface PhpStickerItem {
  file_unique_id: string;
  latest_file_id: string;
  set_name: string | null;
  emoji: string | null;
  sticker_format: string;
  usage_count: number;
  sample_count: number;
  first_seen_at: number | null;
  last_seen_at: number | null;
  analysis_status: string;
  analysis_reason: string | null;
  asset_status: string;
  asset_paths?: { raw?: string | null; preview?: string | null };
  samples?: PhpSample[];
}

interface PhpSample {
  chat_id: number;
  message_id: number;
  date: number;
  from_user_id: number | null;
  username: string | null;
  reply_to_message_id: number | null;
  reply_target_text: string | null;
  context_before?: unknown[];
}

// ── Database setup ───────────────────────

function openDb(): Database.Database {
  const dbPath = resolve(process.env['SQLITE_PATH'] ?? './data/xxb.db');
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  // Run sticker migrations if tables don't exist
  const migrationsDir = resolve(import.meta.dirname ?? '.', '..', 'migrations');
  if (existsSync(migrationsDir)) {
    // Ensure _migrations table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT DEFAULT (datetime('now'))
      );
    `);

    const applied = new Set(
      db.prepare('SELECT name FROM _migrations').all()
        .map((r) => (r as { name: string }).name),
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(resolve(migrationsDir, file), 'utf-8');
      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
      })();
      console.log(`  Applied migration: ${file}`);
    }
  }

  return db;
}

// ── Main ──────────────────────────────────

function main(): void {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // 1. Check PHP data exists
  if (!existsSync(ITEMS_DIR)) {
    console.error(`PHP items dir not found: ${ITEMS_DIR}`);
    process.exit(1);
  }

  // 2. List item files
  const itemFiles = readdirSync(ITEMS_DIR).filter((f) => f.endsWith('.json'));
  console.log(`Found ${itemFiles.length} sticker item file(s)`);

  // 3. Open database
  let db: Database.Database | null = null;
  if (!DRY_RUN) {
    db = openDb();
    console.log(`Database opened: ${process.env['SQLITE_PATH'] ?? './data/xxb.db'}\n`);
  }

  // 4. Prepare statements
  const insertItem = db?.prepare(`
    INSERT OR REPLACE INTO sticker_items (
      file_unique_id, latest_file_id, set_name, emoji, sticker_format,
      usage_count, sample_count, first_seen_at, last_seen_at,
      analysis_status, analysis_reason, analysis_updated_at,
      asset_status, raw_asset_path, preview_asset_path,
      emotion_tags, mood_map, persona_fit, description
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?
    )
  `);

  const insertSample = db?.prepare(`
    INSERT INTO sticker_samples (
      file_unique_id, chat_id, message_id, date,
      from_user_id, username, reply_to_message_id,
      reply_target_text, context_before
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let itemsInserted = 0;
  let samplesInserted = 0;
  let errors = 0;
  let withAnalysis = 0;

  // 5. Process in a single transaction for performance
  const process_all = () => {
    // Clear existing samples first for idempotency (items use INSERT OR REPLACE)
    if (!DRY_RUN) {
      db!.exec('DELETE FROM sticker_samples');
    }

    for (const file of itemFiles) {
      const fuid = file.replace('.json', '');
      try {
        // Read item JSON
        const raw = readFileSync(resolve(ITEMS_DIR, file), 'utf-8');
        const item: PhpStickerItem = JSON.parse(raw);

        // Read markdown analysis (if exists)
        let parsed: ParsedMarkdown = { description: '', emotionTags: [] };
        const mdPath = resolve(MARKDOWN_DIR, `${fuid}.md`);
        if (existsSync(mdPath)) {
          const mdContent = readFileSync(mdPath, 'utf-8');
          parsed = parseMarkdown(mdContent);
          withAnalysis++;
        }

        // Map asset paths
        const rawAssetPath = mapAssetPath(item.asset_paths?.raw, 'raw');
        const previewAssetPath = mapAssetPath(item.asset_paths?.preview, 'preview');

        const now = Math.floor(Date.now() / 1000);

        if (!DRY_RUN) {
          insertItem!.run(
            item.file_unique_id,
            item.latest_file_id,
            item.set_name,
            item.emoji,
            item.sticker_format || 'unknown',
            item.usage_count || 0,
            item.sample_count || 0,
            item.first_seen_at,
            item.last_seen_at,
            item.analysis_status || 'pending',
            item.analysis_reason,
            parsed.description ? now : null,
            item.asset_status || 'missing',
            rawAssetPath,
            previewAssetPath,
            parsed.emotionTags.length > 0 ? JSON.stringify(parsed.emotionTags) : null,
            null, // mood_map — not available from PHP data
            null, // persona_fit — not available from PHP data
            parsed.description || null,
          );
        }
        itemsInserted++;

        // Insert samples
        const samples = item.samples ?? [];
        for (const sample of samples) {
          try {
            if (!DRY_RUN) {
              insertSample!.run(
                item.file_unique_id,
                sample.chat_id,
                sample.message_id,
                sample.date,
                sample.from_user_id,
                sample.username,
                sample.reply_to_message_id,
                sample.reply_target_text,
                sample.context_before ? JSON.stringify(sample.context_before) : null,
              );
            }
            samplesInserted++;
          } catch (sampleErr) {
            errors++;
          }
        }

        if (itemsInserted % 200 === 0) {
          console.log(`  ... ${itemsInserted} / ${itemFiles.length} items processed`);
        }
      } catch (err) {
        errors++;
        console.error(`Error processing ${file}:`, err instanceof Error ? err.message : err);
      }
    }
  };

  if (db) {
    db.transaction(process_all)();
  } else {
    process_all();
  }

  console.log('\n── Summary ──');
  console.log(`Total item files:      ${itemFiles.length}`);
  console.log(`Items inserted:        ${itemsInserted}`);
  console.log(`With analysis (md):    ${withAnalysis}`);
  console.log(`Samples inserted:      ${samplesInserted}`);
  console.log(`Errors:                ${errors}`);
  if (DRY_RUN) console.log('\n(dry run — no data written)');

  db?.close();
}

main();
