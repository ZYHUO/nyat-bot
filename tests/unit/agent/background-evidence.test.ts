import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';
import type { ConversationRef } from '../../../src/platform/types.js';

const f = vi.hoisted(() => ({ db: null as unknown as Database.Database, cfg: {
  MEMORY_PROJECTION_OUTBOX_ENABLED: true, MEMORY_EMBED_MODEL: 'synthetic', MEMORY_COLLECTION: 'synthetic',
  BOT_TOKEN: '12345:synthetic', ONEBOT_ACCOUNT_ID: '90001', OWNER_MEMORY_LINK_ENABLED: true,
  MASTER_UID: 20, ONEBOT_OWNER_ID: '90002', MEMORY_SENSITIVE_CHAT_IDS: [] as number[],
} }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => f.db }));
vi.mock('../../../src/env.js', () => ({ env: () => f.cfg }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
import { createMessageEventIdentity } from '../../../src/shared/event-identity.js';
import { getOrCreateConversationId, getOrCreateMessageId, getOrCreateUserId } from '../../../src/platform/identity-store.js';
import { persistMemorySource, retractMemorySources } from '../../../src/memory/source-store.js';
import { readPublicationEvidence, validatePublicationEvidence } from '../../../src/agent/background-evidence.js';

function telegram(text = '合成来源：修正后为28元', threadId = 0, editAt = 0, uid = 20, role: FormattedMessage['role'] = 'user') {
  const conversation: ConversationRef = { platform: 'telegram', accountId: '12345', idNamespace: 'telegram',
    conversationKind: 'group', id: '-100', ...(threadId ? { threadId: String(threadId) } : {}) };
  const message: FormattedMessage = { role, uid, username: 'synthetic', fullName: 'Synthetic',
    timestamp: 1, messageId: 7, textContent: text, isForwarded: false, messageThreadId: threadId || undefined,
    eventIdentity: createMessageEventIdentity({ ref: { conversation, id: '7' }, occurredAt: 1000,
      receivedAt: 5000 + editAt, edit: editAt > 0, editedAt: editAt || null, updateId: editAt, content: text }) };
  return persistMemorySource(-100, message)!;
}
function qq(rawUid = '90002') {
  const conversation: ConversationRef = { platform: 'qq', accountId: '90001', idNamespace: 'qq-number', conversationKind: 'group', id: '90003' };
  const chatId = getOrCreateConversationId(conversation);
  const messageRef = { conversation, id: '90004' }, messageId = getOrCreateMessageId(messageRef);
  const uid = getOrCreateUserId({ platform: 'qq', accountId: '90001', idNamespace: 'qq-number', id: rawUid });
  const source = persistMemorySource(chatId, { role: 'user', uid, username: '', fullName: 'Synthetic',
    timestamp: 1, messageId, textContent: '同账号 QQ 合成来源', isForwarded: false,
    eventIdentity: createMessageEventIdentity({ ref: messageRef, occurredAt: 1000, content: '同账号 QQ 合成来源' }) })!;
  return { chatId, messageId, source };
}
beforeEach(() => {
  f.db = new Database(':memory:');
  for (const migration of ['0118_platform_identity.sql', '0120_onebot_notices.sql', '0126_memory_projection.sql']) {
    f.db.exec(readFileSync(`migrations/${migration}`, 'utf8'));
  }
  f.cfg.BOT_TOKEN = '12345:synthetic'; f.cfg.ONEBOT_ACCOUNT_ID = '90001';
});
afterEach(() => { f.db.close(); vi.useRealTimers(); });

describe('authoritative message evidence for bound background publication', () => {
  it('returns a real source version with actual event time, not the backfill/import timestamp', () => {
    const row = telegram();
    const proof = readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 });
    expect(proof).toMatchObject({ kind: 'memory_source', sourceId: row.source_id, version: 1,
      chatId: -100, platform: 'telegram', accountId: '12345', threadId: 0, changedAt: 1000, text: row.text_body });
    expect(proof.hash).toMatch(/^[a-f0-9]{64}$/); expect(row.updated_at).toBeGreaterThan(proof.changedAt);
    expect(validatePublicationEvidence(proof)).toBe(true);
  });
  it('keeps thread and conversation boundaries even when owner linking is enabled', () => {
    telegram('私有话题来源', 9);
    expect(() => readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 })).toThrow('scope_invalid');
    expect(() => readPublicationEvidence(-100, 8, { kind: 'message', messageId: 7 })).toThrow('scope_invalid');
    expect(() => readPublicationEvidence(20, 9, { kind: 'message', messageId: 7 })).toThrow('unavailable');
    expect(() => readPublicationEvidence(-200, 9, { kind: 'message', messageId: 7 })).toThrow('unavailable');
    expect(validatePublicationEvidence(readPublicationEvidence(-100, 9, { kind: 'message', messageId: 7 }))).toBe(true);
  });
  it('rejects an old account after a Telegram account change instead of adopting it', () => {
    telegram(); const proof = readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 });
    f.cfg.BOT_TOKEN = '67890:synthetic';
    expect(validatePublicationEvidence(proof)).toBe(false);
    expect(() => readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 })).toThrow('unavailable');
  });
  it.each(['event_id', 'input_revision'])('unknown historical %s never becomes publication evidence', column => {
    telegram(); f.db.prepare(`UPDATE memory_sources SET ${column}=NULL`).run();
    expect(() => readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 })).toThrow('provenance_missing');
  });
  it('requires the actual event-to-source/version relation', () => {
    telegram(); f.db.prepare('DELETE FROM memory_source_events').run();
    expect(() => readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 })).toThrow('provenance_missing');
  });
  it('editing invalidates registered proof and exposes only the latest authoritative text/version', () => {
    telegram(); const first = readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 });
    telegram('最终修正为38元', 0, 2000);
    expect(validatePublicationEvidence(first)).toBe(false);
    const current = readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 });
    expect(current).toMatchObject({ version: 2, changedAt: 2000, text: '最终修正为38元' });
    expect(current.hash).not.toBe(first.hash); expect(validatePublicationEvidence(current)).toBe(true);
  });
  it('a no-op body edit cannot manufacture a new evidence identity for duplicate publication', () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    telegram(); const first = readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 });
    vi.setSystemTime(2000);
    telegram(undefined, 0, 2000);
    const current = readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 });
    expect([current.sourceId, current.version, current.hash]).toEqual([first.sourceId, first.version, first.hash]);
    expect(current.changedAt).toBe(1000); expect(current.changedAt).toBeLessThan(1500);
    expect(validatePublicationEvidence(first)).toBe(true);
    telegram('真正新的正文版本', 0, 2001);
    expect(readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 }).changedAt).toBe(2000);
  });
  it('hashes the full body while returning a bounded, well-formed excerpt', () => {
    const text = '甲'.repeat(1999) + '😀' + '尾部'.repeat(100);
    telegram(text); const first = readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 });
    expect(first.text).toHaveLength(1999); expect(first.text.isWellFormed()).toBe(true);
    telegram(text + '末尾变化', 0, 2000);
    const next = readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 });
    expect(next.text).toBe(first.text); expect(next.hash).not.toBe(first.hash);
  });
  it('source retraction or a standalone retraction record blocks an existing proof', () => {
    const row = telegram(); const proof = readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 });
    f.db.prepare('INSERT INTO memory_retractions VALUES (?,?)').run(row.legacy_id, Date.now());
    expect(validatePublicationEvidence(proof)).toBe(false);
    retractMemorySources([row.legacy_id]);
    expect(() => readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 })).toThrow();
  });
  it.each([['assistant', 12345], ['user', 12345]] as const)('rejects bot output/self-labelled %s sources', (role, uid) => {
    telegram('自己刚发布的通知', 0, 0, uid, role);
    expect(() => readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 })).toThrow();
  });
  it('rejects forged proof fields and source body changes even if version was not bumped', () => {
    const row = telegram(); const proof = readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 });
    for (const change of [{ hash: 'f'.repeat(64) }, { version: 99 }, { sourceId: 'a'.repeat(64) }, { chatId: 20 },
      { platform: 'qq' }, { accountId: '67890' }, { threadId: 9 }, { text: '模型伪造正文' }, { changedAt: Date.now() }]) {
      expect(validatePublicationEvidence({ ...proof, ...change }), JSON.stringify(change)).toBe(false);
    }
    const body = JSON.parse(row.body_json); body.textContent = '没有升版本的正文变更';
    f.db.prepare('UPDATE memory_sources SET body_json=?,text_body=?').run(JSON.stringify(body), body.textContent);
    expect(validatePublicationEvidence(proof)).toBe(false);
  });
  it('QQ requires the actual mapped account and rejects observed recall before publication', () => {
    const item = qq(); const proof = readPublicationEvidence(item.chatId, 0, { kind: 'message', messageId: item.messageId });
    expect(validatePublicationEvidence(proof)).toBe(true);
    f.cfg.ONEBOT_ACCOUNT_ID = '90009'; expect(validatePublicationEvidence(proof)).toBe(false);
    f.cfg.ONEBOT_ACCOUNT_ID = '90001';
    f.db.prepare('INSERT INTO onebot_message_recalls VALUES (?,?,?,?)').run(item.chatId, item.messageId, '90001', Date.now());
    expect(validatePublicationEvidence(proof)).toBe(false);
    expect(() => readPublicationEvidence(item.chatId, 0, { kind: 'message', messageId: item.messageId })).toThrow('retracted');
  });
  it('QQ self output and unresolved internal IDs are rejected', () => {
    const item = qq('90001');
    expect(() => readPublicationEvidence(item.chatId, 0, { kind: 'message', messageId: item.messageId })).toThrow('identity_invalid');
    expect(() => readPublicationEvidence(-(2 ** 52 + 9876), 0, { kind: 'message', messageId: item.messageId })).toThrow();
  });
  it('DB/proof parse failures are fail-closed without returning private text', () => {
    telegram(); const proof = readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 });
    f.db.exec('DROP TABLE memory_source_events');
    expect(validatePublicationEvidence(proof)).toBe(false);
    expect(() => readPublicationEvidence(-100, 0, { kind: 'message', messageId: 7 })).toThrow('publication_source_unavailable');
    expect(validatePublicationEvidence(null)).toBe(false);
  });
});
