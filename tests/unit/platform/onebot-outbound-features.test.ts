import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRef, MessageRef } from '../../../src/platform/types.js';
import type { OneBotSender } from '../../../src/platform/outbound.js';

const f = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: f.db }));

import { clearOneBotSender, registerOneBotSender, sendPlatformMedia, sendPlatformText, reactPlatformMessage } from '../../../src/platform/outbound.js';
import { getOrCreateConversationId, getOrCreateMessageId, findMessageRef } from '../../../src/platform/identity-store.js';
import { OneBotClientError } from '../../../src/platform/onebot-client.js';

const migrations = ['0118_platform_identity.sql', '0120_onebot_notices.sql'].map(name => readFileSync(`migrations/${name}`, 'utf8'));
const group: ConversationRef = { platform: 'qq', accountId: '42', idNamespace: 'qq-number', conversationKind: 'group', id: '123' };
const bytes = Buffer.from('synthetic outbound fixture');
let db: Database.Database;
let chatId: number;
let nativeId: number;
let syntheticId: number;
let receiptNumber: number;
const media = vi.fn<NonNullable<OneBotSender['sendMedia']>>();
const send = vi.fn<OneBotSender['send']>();
const react = vi.fn<NonNullable<OneBotSender['react']>>();
const sender: OneBotSender = { send, sendMedia: media, react, delete: vi.fn(async () => {}) };
function receipt(conversation = group): MessageRef { return { conversation: { ...conversation }, id: String(++receiptNumber) }; }
function state(userId: string, present: number | null, mutedUntil: number | null): void {
  db.prepare(`INSERT INTO onebot_group_member_state (account_id, group_id, user_id, present, muted_until)
    VALUES ('42', '123', ?, ?, ?) ON CONFLICT(account_id, group_id, user_id)
    DO UPDATE SET present=excluded.present, muted_until=excluded.muted_until`).run(userId, present, mutedUntil);
}
function recall(messageId: number): void {
  db.prepare('INSERT INTO onebot_message_recalls VALUES (?, ?, ?, ?)').run(chatId, messageId, '42', Date.now());
}
beforeEach(() => {
  clearOneBotSender(); vi.clearAllMocks();
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); migrations.forEach(sql => db.exec(sql)); f.db.mockReturnValue(db);
  chatId = getOrCreateConversationId(group);
  nativeId = getOrCreateMessageId({ conversation: group, id: '-10' });
  syntheticId = getOrCreateMessageId({ conversation: group, id: `file:${'a'.repeat(64)}` });
  receiptNumber = 1000;
  media.mockImplementation(async input => { input.beforeSend?.(); return receipt(input.conversation); });
  send.mockImplementation(async action => {
    if (action.action !== 'send') throw new Error('Unexpected non-send fixture action');
    return receipt(action.conversation);
  });
  react.mockResolvedValue(undefined);
  registerOneBotSender(sender, '42');
});
afterEach(() => { clearOneBotSender(); db.close(); });

describe('QQ outbound media uses durable scoped identities and receipts', () => {
  it('maps a confirmed media receipt and a native quoted-message reference', async () => {
    const id = await sendPlatformMedia(chatId, 'file', bytes, 'fixture.txt', { caption: '附件', replyToId: nativeId });
    expect(id).toBeGreaterThan(2 ** 52);
    expect(media).toHaveBeenCalledOnce();
    expect(media.mock.calls[0]![0]).toMatchObject({ conversation: group, kind: 'file', bytes,
      fileName: 'fixture.txt', caption: '附件', replyTo: { conversation: group, id: '-10' }, beforeSend: expect.any(Function) });
    expect(findMessageRef(chatId, id)).toEqual({ conversation: group, id: '1001' });
  });

  it('omits synthetic file-notice quotes for both media and text without fabricating a native message ID', async () => {
    await sendPlatformMedia(chatId, 'image', bytes, 'fixture.png', { replyToId: syntheticId });
    expect(media.mock.calls[0]![0].replyTo).toBeUndefined();
    await sendPlatformText(chatId, '文件已读', syntheticId);
    expect(send.mock.calls[0]![0]).toEqual({ action: 'send', conversation: group, segments: [{ type: 'text', text: '文件已读' }] });
    expect(findMessageRef(chatId, syntheticId)?.id).toBe(`file:${'a'.repeat(64)}`);
  });

  it('refuses foreign and unmapped reply references before starting an upload', async () => {
    const other: ConversationRef = { ...group, id: '456' };
    const otherId = getOrCreateMessageId({ conversation: other, id: '-10' });
    for (const replyToId of [otherId, nativeId + 100000, 99]) {
      await expect(sendPlatformMedia(chatId, 'file', bytes, 'fixture.txt', { replyToId }))
        .rejects.toMatchObject({ code: 'unresolved_platform_reply', delivery: 'not_sent' });
    }
    expect(media).not.toHaveBeenCalled();
  });

  it.each(['native', 'synthetic'] as const)('blocks a recalled %s quote before upload or text sending', async kind => {
    const messageId = kind === 'native' ? nativeId : syntheticId; recall(messageId);
    await expect(sendPlatformMedia(chatId, 'file', bytes, 'fixture.txt', { replyToId: messageId }))
      .rejects.toMatchObject({ delivery: 'not_sent' });
    await expect(sendPlatformText(chatId, '不能发出', messageId)).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(media).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it.each(['muted', 'left', 'whole-group-muted'] as const)('blocks media and reactions after observed %s state', async reason => {
    if (reason === 'muted') state('42', 1, Date.now() + 60_000);
    else if (reason === 'left') state('42', 0, null);
    else state('0', null, -1);
    await expect(sendPlatformMedia(chatId, 'file', bytes, 'fixture.txt')).rejects.toMatchObject({ code: 'onebot_chat_unavailable', delivery: 'not_sent' });
    await expect(reactPlatformMessage(chatId, nativeId, '👍')).rejects.toMatchObject({ code: 'onebot_chat_unavailable', delivery: 'not_sent' });
    expect(media).not.toHaveBeenCalled(); expect(react).not.toHaveBeenCalled();
  });

  it('allows a known member after a timed mute has expired', async () => {
    state('42', 1, Date.now() - 1);
    await expect(sendPlatformMedia(chatId, 'file', bytes, 'fixture.txt')).resolves.toBeGreaterThan(2 ** 52);
    await expect(reactPlatformMessage(chatId, nativeId, '👍')).resolves.toBe(true);
  });

  it.each(['muted', 'left', 'recalled', 'synthetic-recalled', 'whole-group-muted'] as const)
    ('rechecks %s state after upload and before the transport effect', async reason => {
      let sendEffects = 0;
      const quote = reason === 'synthetic-recalled' ? syntheticId : nativeId;
      media.mockImplementation(async input => {
        // Simulate a state update while the transport stages the file. The
        // real client's hook timing and not-sent error mapping have WS tests.
        await Promise.resolve();
        if (reason === 'muted') state('42', 1, -1);
        else if (reason === 'left') state('42', 0, null);
        else if (reason === 'whole-group-muted') state('0', null, -1);
        else recall(quote);
        input.beforeSend?.(); sendEffects += 1;
        return receipt(input.conversation);
      });
      await expect(sendPlatformMedia(chatId, 'file', bytes, 'fixture.txt', { replyToId: quote })).rejects.toMatchObject({ delivery: 'not_sent' });
      expect(media).toHaveBeenCalledOnce(); expect(sendEffects).toBe(0);
      expect(receiptNumber).toBe(1000);
    });

  it('calls the caller-specific host guard after the platform guards', async () => {
    const guard = vi.fn(() => { throw new Error('synthetic task cancelled'); });
    await expect(sendPlatformMedia(chatId, 'file', bytes, 'fixture.txt', { beforeSend: guard })).rejects.toThrow('synthetic task cancelled');
    expect(guard).toHaveBeenCalledOnce(); expect(receiptNumber).toBe(1000);
  });

  it('keeps unknown delivery unchanged and never retries a media request', async () => {
    const error = new OneBotClientError('request_timeout', 'unknown'); media.mockRejectedValue(error);
    await expect(sendPlatformMedia(chatId, 'file', bytes, 'fixture.txt')).rejects.toBe(error);
    expect(media).toHaveBeenCalledOnce();
  });

  it('treats a foreign successful receipt as unknown instead of persisting a false local success', async () => {
    media.mockResolvedValue({ conversation: { ...group, accountId: '43' }, id: '1001' });
    await expect(sendPlatformMedia(chatId, 'file', bytes, 'fixture.txt'))
      .rejects.toMatchObject({ code: 'onebot_receipt_unavailable', delivery: 'unknown' });
    expect(media).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT COUNT(*) AS n FROM platform_identity_refs WHERE ref_kind = 'message'").get()).toEqual({ n: 2 });
  });

  it('fails closed before upload if the notice-state table is unavailable', async () => {
    db.exec('DROP TABLE onebot_group_member_state');
    await expect(sendPlatformMedia(chatId, 'file', bytes, 'fixture.txt')).rejects.toMatchObject({ code: 'onebot_chat_state_unavailable', delivery: 'not_sent' });
    expect(media).not.toHaveBeenCalled();
  });
});

describe('QQ reactions preserve scope and confirmation', () => {
  it('uses the native same-chat reference and returns success only after the client ACK', async () => {
    let acknowledge!: () => void; const waiting = new Promise<void>(resolve => { acknowledge = resolve; });
    react.mockReturnValue(waiting);
    const pending = reactPlatformMessage(chatId, nativeId, '👍');
    let completed = false; void pending.then(() => { completed = true; });
    await Promise.resolve(); expect(completed).toBe(false);
    expect(react).toHaveBeenCalledWith({ conversation: group, id: '-10' }, '👍');
    acknowledge(); await expect(pending).resolves.toBe(true);
  });

  it('rejects cross-conversation, cross-account and recalled targets before calling the client', async () => {
    const foreignChat = getOrCreateConversationId({ ...group, id: '456' });
    const foreignAccount = getOrCreateConversationId({ ...group, accountId: '43' });
    await expect(reactPlatformMessage(foreignChat, nativeId, '👍')).rejects.toMatchObject({ code: 'unresolved_platform_message' });
    await expect(reactPlatformMessage(foreignAccount, nativeId, '👍')).rejects.toMatchObject({ code: 'onebot_sender_unavailable' });
    recall(nativeId);
    await expect(reactPlatformMessage(chatId, nativeId, '👍')).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(react).not.toHaveBeenCalled();
  });

  it('propagates an uncertain reaction ACK without inventing success or retrying', async () => {
    const error = new OneBotClientError('request_timeout', 'unknown'); react.mockRejectedValue(error);
    await expect(reactPlatformMessage(chatId, nativeId, '👍')).rejects.toBe(error);
    expect(react).toHaveBeenCalledOnce();
  });
});
