/** Pure engine only: never import the app adapter, env, queue, cron or platform. */
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { NyatDb } from '../packages/nyatdb/src/engine.js';
import { PAGE_SIZE, PageType, SCHEMA_VERSION } from '../packages/nyatdb/src/format/constants.js';
import { Page } from '../packages/nyatdb/src/format/page.js';
import { decodeChatTuple, type ChatTuple } from '../packages/nyatdb/src/format/codec.js';
import { loadMsgIndex } from '../packages/nyatdb/src/index/msg-index.js';

function scopeOf(page: Page): number {
  const raw = page.buf.readBigInt64LE(32);
  const scope = Number(raw);
  // Legacy internal topic keys can exceed MAX_SAFE_INTEGER. Accept only the
  // exact integers representable by the engine's number API, never rounding.
  if (!Number.isInteger(scope) || BigInt(scope) !== raw) throw new Error('scope-precision');
  return scope;
}

function scanPages(directory: string, visit: (page: Page) => void): void {
  const path = join(directory, 'heap.ndb');
  const size = statSync(path).size;
  if (size < 5 * PAGE_SIZE || size % PAGE_SIZE !== 0) throw new Error('format');
  const fd = openSync(path, 'r');
  try {
    for (let offset = 0; offset < size; offset += PAGE_SIZE) {
      const buffer = Buffer.alloc(PAGE_SIZE);
      if (readSync(fd, buffer, 0, PAGE_SIZE, offset) !== PAGE_SIZE) throw new Error('short-read');
      const page = new Page(buffer);
      if (!page.verifyMagic() || !page.checkCrc() || page.pageId !== offset / PAGE_SIZE) throw new Error('original-page-corruption');
      if (page.type === PageType.Chat) scopeOf(page);
      visit(page);
    }
  } finally { closeSync(fd); }
}

function sameTuple(left: ChatTuple, right: ChatTuple): boolean {
  return left.messageId === right.messageId && left.text === right.text && left.uid === right.uid
    && left.ts === right.ts && left.role === right.role;
}

let database: NyatDb | undefined;
try {
  const directory = process.argv[2];
  if (!directory || resolve(directory) !== realpathSync(directory) || lstatSync(directory).isSymbolicLink()) throw new Error('path');
  for (const name of ['ENGINE.json', 'heap.ndb', 'wal/redo.wal']) {
    const path = join(directory, name);
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile() || realpathSync(path) !== path) throw new Error('file');
  }
  const metadata = JSON.parse(readFileSync(join(directory, 'ENGINE.json'), 'utf8')) as { schema?: unknown };
  if (metadata.schema !== SCHEMA_VERSION) throw new Error('format');
  // Opening can relink pages and WAL replay can dirty the buffer pool. Verify
  // the original restored bytes first so checkpoint cannot hide bad CRCs.
  scanPages(directory, () => {});
  database = NyatDb.open({ path: directory, verifyOnOpen: true });
  // This is already a disposable second copy made by restore-drill.py. Flush
  // recovered WAL state before raw-page sampling; never checkpoint the archive
  // or the first restored copy. No application adapter is loaded here.
  database.checkpoint();
  // Independently reopen the persisted recovery image. First-open isolation is
  // separately enforced by engine tests; this validates the checkpoint on disk.
  database.close({ skipCheckpoint: true });
  database = NyatDb.open({ path: directory, verifyOnOpen: true });
  const verified = database.verify();
  const recovered = JSON.parse(readFileSync(join(directory, 'ENGINE.json'), 'utf8')) as { checkpointLsn?: string };
  const index = loadMsgIndex(directory, BigInt(recovered.checkpointLsn ?? '0'));
  if (!index || index.size !== database.stats().indexed) throw new Error('index-snapshot');
  // Read-side scope guards must not hide a corrupt persisted index. Verify all
  // entries against physical ownership, including entries in unsampled scopes.
  const indexedPages = new Map<number, Array<{ chatId: number; messageId: number; slot: number }>>();
  index.forEach((chatId, messageId, pageId, slot) => {
    const entries = indexedPages.get(pageId) ?? [];
    entries.push({ chatId, messageId, slot });
    indexedPages.set(pageId, entries);
  });
  scanPages(directory, page => {
    const entries = indexedPages.get(page.pageId);
    if (!entries) return;
    if (page.type !== PageType.Chat) throw new Error('index-page-type');
    const owner = scopeOf(page);
    for (const entry of entries) {
      const tuple = page.getTupleView(entry.slot);
      if (owner !== entry.chatId || !tuple || decodeChatTuple(tuple).messageId !== entry.messageId) {
        throw new Error('index-physical-owner');
      }
    }
    indexedPages.delete(page.pageId);
  });
  if (indexedPages.size) throw new Error('index-missing-page');
  const scopes = new Set<number>();
  scanPages(directory, page => { if (page.type === PageType.Chat) scopes.add(scopeOf(page)); });
  // Zero is a legal legacy engine scope. Choose a scope proven absent, rather
  // than assuming any fixed number has never been stored.
  let absentScope = 0;
  while (scopes.has(absentScope)) absentScope++;
  let sampledMessages = 0;
  const samples: number[] = [];
  const wanted = new Map<number, Array<{ row: ChatTuple; point: ChatTuple; rowFound: boolean; pointFound: boolean }>>();
  for (const chatId of scopes) {
    const recent = database.chatRecent(chatId, 3);
    if (!recent.length) continue; // Empty Chat pages have no positive records to sample.
    samples.push(chatId);
    const checks: Array<{ row: ChatTuple; point: ChatTuple; rowFound: boolean; pointFound: boolean }> = [];
    for (const row of recent) {
      const point = database.chatGet(chatId, row.messageId);
      if (!point || database.chatGet(absentScope, row.messageId) !== null) throw new Error('scope-index');
      checks.push({ row, point, rowFound: false, pointFound: false });
      sampledMessages++;
    }
    wanted.set(chatId, checks);
    if (samples.length === 3) break;
  }
  // Recent history can contain several physical revisions of the same ID;
  // point lookup need not equal the old revision (nor the newest timestamp).
  // Both results must independently exist in this exact scope and message ID.
  scanPages(directory, page => {
    if (page.type !== PageType.Chat) return;
    const checks = wanted.get(scopeOf(page));
    if (!checks) return;
    for (const raw of page.allTuples()) {
      const tuple = decodeChatTuple(raw);
      for (const check of checks) {
        if (sameTuple(tuple, check.row)) check.rowFound = true;
        if (sameTuple(tuple, check.point)) check.pointFound = true;
      }
    }
  });
  if ([...wanted.values()].flat().some(check => !check.rowFound || !check.pointFound)) throw new Error('scope-physical-version');
  if (database.chatRecent(absentScope, 1).length) throw new Error('empty-scope');
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
