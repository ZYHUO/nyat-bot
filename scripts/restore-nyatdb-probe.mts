/** Pure engine only: never import the app adapter, env, queue, cron or platform. */
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { NyatDb } from '../packages/nyatdb/src/engine.js';
import { PAGE_SIZE, PageType, SCHEMA_VERSION } from '../packages/nyatdb/src/format/constants.js';

let database: NyatDb | undefined;
try {
  const directory = process.argv[2];
  if (!directory || resolve(directory) !== realpathSync(directory) || lstatSync(directory).isSymbolicLink()) throw new Error('path');
  for (const name of ['ENGINE.json', 'heap.ndb', 'wal/redo.wal']) {
    const path = join(directory, name);
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || realpathSync(path) !== path) throw new Error('file');
  }
  const metadata = JSON.parse(readFileSync(join(directory, 'ENGINE.json'), 'utf8')) as { schema?: unknown };
  const size = statSync(join(directory, 'heap.ndb')).size;
  if (metadata.schema !== SCHEMA_VERSION || size < 5 * PAGE_SIZE || size % PAGE_SIZE !== 0) throw new Error('format');
  database = NyatDb.open({ path: directory, verifyOnOpen: true });
  const verified = database.verify();
  const scopes = new Set<number>();
  const fd = openSync(join(directory, 'heap.ndb'), 'r');
  try {
    const header = Buffer.alloc(64);
    for (let page = 0; page < verified.pages; page++) {
      if (readSync(fd, header, 0, header.length, page * PAGE_SIZE) !== header.length) throw new Error('short-read');
      if (header.readUInt8(4) === PageType.Chat && header.readUInt16LE(18) > 0) {
        const chatId = Number(header.readBigInt64LE(32));
        if (!Number.isSafeInteger(chatId) || chatId === 0) throw new Error('scope');
        scopes.add(chatId);
      }
    }
  } finally { closeSync(fd); }
  let sampledMessages = 0;
  const samples = [...scopes].slice(0, 3);
  for (const chatId of samples) {
    const recent = database.chatRecent(chatId, 3);
    if (!recent.length) throw new Error('scope-query-empty');
    for (const row of recent) {
      const point = database.chatGet(chatId, row.messageId);
      if (!point || point.text !== row.text || point.uid !== row.uid || point.ts !== row.ts || point.role !== row.role
        || database.chatGet(0, row.messageId) !== null) throw new Error('scope-index');
      sampledMessages++;
    }
  }
  if (database.chatRecent(0, 1).length) throw new Error('empty-scope');
  const stats = database.stats();
  if (stats.indexed > 0 && sampledMessages === 0) throw new Error('no-positive-query');
  database.close({ skipCheckpoint: true }); database = undefined;
  process.stdout.write(JSON.stringify({ ok: true, pages: verified.pages, chats: stats.chats,
    recalls: stats.recalls, indexed: stats.indexed, sampledChats: samples.length, sampledMessages,
    emptyScopeChecked: true }) + '\n');
} catch {
  // Native/parser exceptions can embed data or paths. Only a static code escapes.
  try { database?.close({ skipCheckpoint: true }); } catch { /* child exit closes its descriptors */ }
  process.stderr.write('nyatdb_restore_probe_failed\n');
  process.exitCode = 1;
}
