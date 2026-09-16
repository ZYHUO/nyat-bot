/**
 * Export person-centric rows from xxb.db for audit / backup.
 * Live Meta+Subagent already reads the same DB + Qdrant via host.memory.
 *
 *   npx tsx scripts/migrate-xxb-memory-export.ts > /tmp/nyat-person-export.json
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const dbPath = process.env['SQLITE_PATH'] || resolve('data/xxb.db');
const db = new Database(dbPath, { readonly: true });

function tableExists(name: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) as
    | { name: string }
    | undefined;
  return !!row;
}

const out: Record<string, unknown> = {
  exportedAt: new Date().toISOString(),
  dbPath,
  person_identity: [] as unknown[],
  user_profiles_sample: [] as unknown[],
  user_profile_sections_sample: [] as unknown[],
  person_aliases_sample: [] as unknown[],
};

if (tableExists('person_identity')) {
  out.person_identity = db.prepare(`SELECT * FROM person_identity LIMIT 5000`).all();
}

if (tableExists('user_profiles')) {
  out.user_profiles_sample = db
    .prepare(
      `SELECT chat_id, uid, username, full_name, substr(profile_prompt,1,500) AS profile_prompt_head, updated_at
       FROM user_profiles ORDER BY updated_at DESC LIMIT 2000`,
    )
    .all();
}

if (tableExists('user_profile_sections')) {
  out.user_profile_sections_sample = db
    .prepare(`SELECT * FROM user_profile_sections ORDER BY updated_at DESC LIMIT 2000`)
    .all();
}

if (tableExists('person_aliases')) {
  out.person_aliases_sample = db.prepare(`SELECT * FROM person_aliases LIMIT 2000`).all();
}

db.close();
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
