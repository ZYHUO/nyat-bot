import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import type { FormattedMessage } from '../../../src/shared/types.js';

const f = vi.hoisted(() => ({ db: null as unknown as Database.Database, cfg: {
  MEMORY_PROJECTION_OUTBOX_ENABLED: true, MEMORY_EMBED_MODEL: 'test-model', MEMORY_COLLECTION: 'test-vectors',
  BOT_TOKEN: '12345:synthetic', MEMORY_SENSITIVE_CHAT_IDS: [] as number[],
} }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/env.js', () => ({ env: () => f.cfg }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';
import { fromTelegramChatId } from '../../../src/platform/identity.js';
import { authoritativeMemoryPayload, checkpointMemoryVector, claimMemoryProjection, completeMemoryProjection, currentProjection,
  failMemoryProjection, getMemorySource, memoryProjectionStats, persistMemorySource, retractMemorySources, retryFailedMemoryProjections } from '../../../src/memory/source-store.js';
import { drainMemoryProjections } from '../../../src/memory/projection-worker.js';
import { searchLexical } from '../../../src/memory/lexical.js';

const chat = -100;
function message(text = '原始正文', id = 7, edit = 0, received = 1000): FormattedMessage {
  return { role: 'user', uid: 3, username: 'u', fullName: 'User', timestamp: 1, messageId: id,
    textContent: text, isForwarded: false,
    eventIdentity: createMessageEventIdentity({ ref: { conversation: fromTelegramChatId('12345', chat), id: String(id) },
      occurredAt: 1000, editedAt: edit || null, receivedAt: received, edit: edit > 0, updateId: received, content: text }),
  } as FormattedMessage;
}
function adapter() { return { embed: vi.fn(async () => [0.1, 0.2]), upsert: vi.fn(async () => {}), remove: vi.fn(async () => {}) }; }
beforeEach(() => {
  f.db = new Database(':memory:');
  f.db.exec(readFileSync('migrations/0126_memory_projection.sql', 'utf8'));
  f.db.exec(readFileSync('migrations/0051_memory_fts.sql', 'utf8'));
  f.cfg.MEMORY_PROJECTION_OUTBOX_ENABLED = true; f.cfg.BOT_TOKEN = '12345:synthetic';
  f.cfg.MEMORY_EMBED_MODEL = 'test-model';
});
afterEach(() => { f.db.close(); vi.useRealTimers(); });

describe('source body authority and replayable vector/FTS projection', () => {
  it('atomically stores source and intent before embedding, and replay is idempotent', async () => {
    const source = persistMemorySource(chat, message())!;
    expect(source.text_body).toBe('原始正文');
    expect(persistMemorySource(chat, message())?.version).toBe(1);
    expect(memoryProjectionStats().pending).toBe(1);
    const run = adapter(); run.embed.mockRejectedValueOnce(new Error('private-provider-details'));
    expect(await drainMemoryProjections(run)).toMatchObject({ claimed: 1, failed: 1 });
    expect(getMemorySource(source.source_id)?.text_body).toBe('原始正文');
    expect(run.upsert).not.toHaveBeenCalled();
    const job = f.db.prepare('SELECT last_error,state FROM memory_projection_jobs').get();
    expect(job).toEqual({ last_error: 'embedding_failed', state: 'pending' });
    f.db.prepare('UPDATE memory_projection_jobs SET next_attempt_at=0').run();
    expect(await drainMemoryProjections(run)).toMatchObject({ completed: 1 });
    expect(searchLexical(f.db, chat, '原始正文', 5)).toHaveLength(1);
    expect(memoryProjectionStats()).toMatchObject({ pending: 0, completed: 1 });
  });

  it('rolls back source body when outbox insertion fails', () => {
    f.db.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON memory_projection_jobs BEGIN SELECT RAISE(ABORT,'disk-full'); END");
    expect(() => persistMemorySource(chat, message())).toThrow('disk-full');
    expect(f.db.prepare('SELECT COUNT(*) n FROM memory_sources').get()).toEqual({ n: 0 });
  });

  it('bounds a stuck embedder and does not continue to send when it resolves late', async () => {
    vi.useFakeTimers();
    persistMemorySource(chat, message());
    const run = adapter();
    let release!: (vector: number[]) => void;
    run.embed.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const draining = drainMemoryProjections(run);
    await vi.advanceTimersByTimeAsync(20_001);
    expect(await draining).toMatchObject({ claimed: 1, failed: 1 });
    expect(f.db.prepare('SELECT state,last_error FROM memory_projection_jobs').get()).toEqual({ state: 'pending', last_error: 'embedding_timeout' });
    release([1, 2]); await Promise.resolve();
    expect(run.upsert).not.toHaveBeenCalled();
    expect(memoryProjectionStats().pending).toBe(1);
  });

  it('checkpoints confirmed vectors so a lexical failure only retries lexical', async () => {
    persistMemorySource(chat, message());
    f.db.exec('DROP TABLE memory_fts');
    const run = adapter();
    expect(await drainMemoryProjections(run)).toMatchObject({ failed: 1 });
    expect(f.db.prepare('SELECT vector_done,last_error FROM memory_projection_jobs').get()).toEqual({ vector_done: 1, last_error: 'lexical_failed' });
    f.db.exec(readFileSync('migrations/0051_memory_fts.sql', 'utf8'));
    f.db.prepare('UPDATE memory_projection_jobs SET next_attempt_at=0').run();
    expect(await drainMemoryProjections(run)).toMatchObject({ completed: 1 });
    expect(run.embed).toHaveBeenCalledTimes(1); expect(run.upsert).toHaveBeenCalledTimes(1);
  });

  it('keeps the latest of two edits and rejects replayed originals and stale projection bodies', async () => {
    const original = message(); const first = persistMemorySource(chat, original)!;
    const oldJob = claimMemoryProjection()!;
    const second = persistMemorySource(chat, message('第一次编辑', 7, 2000, 2001))!;
    const latest = persistMemorySource(chat, message('最终编辑', 7, 2000, 2002))!;
    expect([first.version, second.version, latest.version]).toEqual([1, 2, 3]);
    expect(persistMemorySource(chat, original)?.text_body).toBe('最终编辑');
    expect(persistMemorySource(chat, message('迟到旧编辑', 7, 1500, 3000))?.version).toBe(3);
    expect(currentProjection(oldJob)).toBeNull();
    expect(checkpointMemoryVector(oldJob)).toBe(false);
    expect(authoritativeMemoryPayload({ sourceId: first.source_id, sourceVersion: 1, text: '伪造旧正文' })).toBeNull();
    expect(authoritativeMemoryPayload({ sourceId: first.source_id, sourceVersion: 3, text: '伪造正文', chatId: 999 }))
      .toMatchObject({ text: '最终编辑', chatId: chat, sourceAccountId: '12345' });
    const run = adapter(); await drainMemoryProjections(run);
    expect(run.upsert).toHaveBeenCalledTimes(1);
    expect(run.upsert.mock.calls[0]?.[0]).toMatchObject({ version: 3, text_body: '最终编辑' });
  });

  it('does not rewind after a same-body edit updated the event ordering', () => {
    persistMemorySource(chat, message());
    persistMemorySource(chat, message('原始正文', 7, 3000, 3001));
    expect(persistMemorySource(chat, message('迟到编辑', 7, 2000, 4000))?.text_body).toBe('原始正文');
  });

  it('fences expired workers and completes only the new claim', () => {
    persistMemorySource(chat, message());
    const now = Date.now(); const old = claimMemoryProjection(now, 10)!;
    const fresh = claimMemoryProjection(now + 11, 100)!;
    const lexical = vi.fn();
    expect(completeMemoryProjection(old, lexical, now + 12)).toBe(false);
    expect(lexical).not.toHaveBeenCalled();
    expect(completeMemoryProjection(fresh, lexical, now + 12)).toBe(true);
    expect(lexical).toHaveBeenCalledOnce();
  });

  it('a revoke during embedding blocks upsert, and a late old RPC cannot be read', async () => {
    const source = persistMemorySource(chat, message())!;
    const run = adapter();
    run.embed.mockImplementationOnce(async () => { retractMemorySources([source.legacy_id]); return [1, 2]; });
    expect(await drainMemoryProjections(run, 1)).toMatchObject({ superseded: 1 });
    expect(run.upsert).not.toHaveBeenCalled();
    expect(authoritativeMemoryPayload({ sourceId: source.source_id, sourceVersion: 1 })).toBeNull();
    expect(getMemorySource(source.source_id)).toMatchObject({ tombstone: 1, text_body: '', body_json: '{}' });
    expect(persistMemorySource(chat, message('重放旧正文'))?.tombstone).toBe(1);
    await drainMemoryProjections(run);
    expect(run.remove).toHaveBeenCalledOnce();
  });

  it('retracts a legacy-only vector durably and never relabels it as current body', async () => {
    const legacy = { mid: '-100_77', chatId: chat, messageId: 77, text: '旧账号未知正文' };
    expect(authoritativeMemoryPayload(legacy)).toEqual(legacy);
    retractMemorySources(['-100_77']);
    expect(authoritativeMemoryPayload(legacy)).toBeNull();
    expect(authoritativeMemoryPayload({ ...legacy, mid: '-200_88' })).toBeNull();
    const run = adapter(); await drainMemoryProjections(run);
    expect(run.embed).not.toHaveBeenCalled(); expect(run.remove).toHaveBeenCalledOnce();
  });

  it('disabling the write flag cannot bypass source tombstones or use pointer payload text', () => {
    const source = persistMemorySource(chat, message())!;
    retractMemorySources([source.legacy_id]);
    f.cfg.MEMORY_PROJECTION_OUTBOX_ENABLED = false;
    expect(persistMemorySource(chat, message('关闭后消息', 8))).toBeNull();
    expect(authoritativeMemoryPayload({ sourceId: source.source_id, sourceVersion: 1, text: '旧正文' })).toBeNull();
    expect(authoritativeMemoryPayload({ sourceId: 'unknown', sourceVersion: 1, text: '伪造正文' })).toBeNull();
  });

  it('does not embed a pending job using a different model or accept another account identity', async () => {
    persistMemorySource(chat, message());
    f.cfg.MEMORY_EMBED_MODEL = 'different-model';
    const run = adapter(); expect(await drainMemoryProjections(run)).toMatchObject({ claimed: 0 });
    expect(run.embed).not.toHaveBeenCalled();
    f.cfg.BOT_TOKEN = '98765:another-synthetic';
    expect(() => persistMemorySource(chat, message())).toThrow('identity_mismatch');
  });

  it('rejects unproven historical messages and cannot upgrade sensitive or DM visibility', () => {
    const old = { ...message(), eventIdentity: undefined } as FormattedMessage;
    expect(() => persistMemorySource(chat, old)).toThrow('event_identity_required');
    f.cfg.MEMORY_SENSITIVE_CHAT_IDS = [chat];
    expect(persistMemorySource(chat, message(), 'public')?.visibility).toBe('private');
    f.cfg.MEMORY_SENSITIVE_CHAT_IDS = [];
    const dm = { ...message('私聊正文', 4), eventIdentity: createMessageEventIdentity({
      ref: { conversation: fromTelegramChatId('12345', 99), id: '4' }, occurredAt: 1000 }) } as FormattedMessage;
    expect(persistMemorySource(99, dm, 'public')?.visibility).toBe('private');
    const source = persistMemorySource(chat, message('另一个正文', 10))!;
    expect(authoritativeMemoryPayload({ sourceId: source.source_id, sourceVersion: 1, mid: '999_999' })?.['mid']).toBe('-100_10');
  });

  it('records repeated failures in a failed queue and reports a bounded watermark', () => {
    persistMemorySource(chat, message());
    for (let i = 0; i < 8; i++) {
      const job = claimMemoryProjection(Date.now() + 999_999_999)!;
      failMemoryProjection(job, 'embedding_failed', 0);
    }
    expect(memoryProjectionStats()).toMatchObject({ failed: 1, pending: 0, running: 0, completed: 0 });
    expect(claimMemoryProjection(Date.now() + 999_999_999)).toBeNull();
    f.cfg.MEMORY_EMBED_MODEL = 'incompatible-model';
    expect(retryFailedMemoryProjections()).toBe(0);
    f.cfg.MEMORY_EMBED_MODEL = 'test-model';
    expect(retryFailedMemoryProjections()).toBe(1);
    expect(claimMemoryProjection()?.attempts).toBe(1);
  });
});
