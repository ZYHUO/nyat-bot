import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OneBotMediaDescriptor } from '../../../src/platform/onebot-media.js';
import type { OneBotTransferTransport } from '../../../src/platform/onebot-media-stream.js';
import type { ConversationRef } from '../../../src/platform/types.js';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), get: vi.fn(), set: vi.fn(), request: vi.fn(), lookup: vi.fn() }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: mocks.getDb }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ get: mocks.get, set: mocks.set }) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('node:http', () => ({ request: mocks.request }));
vi.mock('node:https', () => ({ request: mocks.request }));
vi.mock('dns/promises', () => ({ lookup: mocks.lookup }));
import { getOrCreateConversationId, getOrCreateMessageId } from '../../../src/platform/identity-store.js';
import {
  assertOneBotMediaUrl, downloadOneBotMediaUrl, ONEBOT_MEDIA_TTL_SEC,
  registerOneBotMedia, resolveOneBotMedia, setOneBotMediaTransport,
} from '../../../src/platform/onebot-media.js';

const migration = readFileSync('migrations/0118_platform_identity.sql', 'utf8');
const noticeMigration = readFileSync('migrations/0120_onebot_notices.sql', 'utf8');
const group: ConversationRef = { platform: 'qq', accountId: '80001', idNamespace: 'qq-number', conversationKind: 'group', id: '70001' };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const descriptor: OneBotMediaDescriptor = { message: { conversation: group, id: '1' }, kind: 'image', assetId: 'image.png', fileName: '图片.png' };
let db: Database.Database; let chatId: number;
let records: Map<string, string>;
const disposers: Array<() => void> = [];
beforeEach(() => {
  vi.clearAllMocks(); records = new Map();
  db = new Database(':memory:'); db.exec(migration); db.exec(noticeMigration); mocks.getDb.mockReturnValue(db);
  chatId = getOrCreateConversationId(group);
  mocks.get.mockImplementation(async (key: string) => records.get(key) ?? null);
  mocks.set.mockImplementation(async (key: string, value: string) => { records.set(key, value); return 'OK'; });
  mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
});
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); db.close(); vi.useRealTimers(); });
function transport(bytes = png): OneBotTransferTransport {
  return { request: vi.fn(), streamAction: vi.fn(async (_action, _params, options) => {
    options.onFrame({ type: 'stream', data_type: 'file_info', file_name: 'image.png', file_size: bytes.length, chunk_size: 49152 });
    const data = bytes.toString('base64');
    options.onFrame({ type: 'stream', data_type: 'file_chunk', index: 0, data, size: bytes.length, base64_size: data.length });
    options.onFrame({ type: 'response', data_type: 'file_complete', total_chunks: 1, total_bytes: bytes.length });
  }) };
}
function useTransport(value = transport()) {
  const factory = vi.fn(() => value); disposers.push(setOneBotMediaTransport(group.accountId, factory)); return { value, factory };
}

describe('opaque QQ media registry', () => {
  it('persists only bounded metadata with a TTL and resolves through one account connection', async () => {
    const { factory, value } = useTransport(); const handle = await registerOneBotMedia(descriptor);
    expect(handle).toMatch(/^qq-media:[a-f0-9-]{36}$/);
    expect(handle).not.toContain(group.id);
    expect(mocks.set).toHaveBeenCalledWith(expect.stringMatching(/^xxb:onebot:media:/), expect.any(String), 'EX', ONEBOT_MEDIA_TTL_SEC, 'NX');
    expect([...records.values()][0]).not.toContain(png.toString('base64'));
    expect(await resolveOneBotMedia(handle, chatId)).toEqual({ bytes: png, mimeType: 'image/png', fileName: '图片.png', assertAvailable: expect.any(Function) });
    expect(factory).toHaveBeenCalledTimes(1); expect(value.streamAction).toHaveBeenCalledTimes(1);
  });
  it('rejects copied handles in another group, account, private chat or Telegram', async () => {
    const { value } = useTransport(); const handle = await registerOneBotMedia(descriptor);
    for (const ref of [{ ...group, id: '70002' }, { ...group, accountId: '80002' }, { ...group, conversationKind: 'private' as const }]) {
      await expect(resolveOneBotMedia(handle, getOrCreateConversationId(ref))).rejects.toThrow('qq_media_wrong_context');
    }
    await expect(resolveOneBotMedia(handle, -70001)).rejects.toThrow('qq_media_wrong_context');
    await expect(resolveOneBotMedia(handle)).rejects.toThrow('qq_media_context_required');
    expect(value.streamAction).not.toHaveBeenCalled();
  });
  it('requires a live Redis handle, not a structurally plausible capability', async () => {
    useTransport();
    await expect(resolveOneBotMedia('qq-media:11111111-1111-4111-8111-111111111111', chatId)).rejects.toThrow('qq_media_expired');
    const handle = await registerOneBotMedia(descriptor);
    const [key, value] = [...records.entries()][0]!;
    records.set(key, JSON.stringify({ ...JSON.parse(value), expiresAt: Date.now() - 1 }));
    await expect(resolveOneBotMedia(handle, chatId)).rejects.toThrow('qq_media_expired');
  });
  it('fails closed on Redis failure and corrupted metadata, without provider data in errors', async () => {
    mocks.set.mockRejectedValueOnce(new Error('secret credential'));
    await expect(registerOneBotMedia(descriptor)).rejects.toThrow('qq_media_registry_unavailable');
    const handle = await registerOneBotMedia(descriptor);
    records.set([...records.keys()][0]!, '{secret credential');
    await expect(resolveOneBotMedia(handle, chatId)).rejects.toThrow('qq_media_resolution_failed');
  });
  it('refuses local paths, URL IDs and cross-platform registrations', async () => {
    for (const assetId of ['/etc/passwd', 'file:///etc/passwd', 'https://qq.com/file']) {
      await expect(registerOneBotMedia({ ...descriptor, assetId })).rejects.toThrow('qq_media_invalid_descriptor');
    }
    await expect(registerOneBotMedia({ ...descriptor, message: { ...descriptor.message,
      conversation: { ...group, platform: 'telegram', idNamespace: 'telegram' } } })).rejects.toThrow('qq_media_invalid_descriptor');
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('checks claimed size before network and actual image bytes before model use', async () => {
    const { value } = useTransport(transport(Buffer.from('<html>not an image</html>')));
    const oversized = await registerOneBotMedia({ ...descriptor, fileSize: 100 });
    await expect(resolveOneBotMedia(oversized, chatId, { maxBytes: 5 })).rejects.toThrow('qq_media_too_large');
    expect(value.streamAction).not.toHaveBeenCalled();
    await expect(resolveOneBotMedia(await registerOneBotMedia(descriptor), chatId)).rejects.toThrow('qq_media_image_type_refused');
  });
  it('does not fall through to HTTP after a failed authenticated stream', async () => {
    const value = transport(); vi.mocked(value.streamAction).mockRejectedValueOnce(new Error('private server details'));
    useTransport(value);
    const handle = await registerOneBotMedia({ ...descriptor, url: 'https://gchat.qpic.cn/image' });
    await expect(resolveOneBotMedia(handle, chatId)).rejects.toThrow('qq_media_resolution_failed');
    expect(mocks.request).not.toHaveBeenCalled();
  });
});

function recall(source = descriptor.message): void {
  const sourceChatId = getOrCreateConversationId(source.conversation);
  const sourceId = getOrCreateMessageId(source);
  db.prepare('INSERT INTO onebot_message_recalls (chat_id, message_id, account_id, recalled_at) VALUES (?, ?, ?, ?)')
    .run(sourceChatId, sourceId, source.conversation.accountId, Date.now());
}

describe('QQ media source-message revocation', () => {
  it('rejects a recalled source before starting any network download', async () => {
    const { value } = useTransport(); const handle = await registerOneBotMedia(descriptor);
    recall();
    await expect(resolveOneBotMedia(handle, chatId)).rejects.toThrow('qq_media_source_recalled');
    expect(value.streamAction).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled();
  });
  it('rechecks a recall arriving during stream download before returning bytes', async () => {
    const value = transport(); const original = value.streamAction;
    value.streamAction = vi.fn(async (action, params, options) => original(action, params, {
      ...options, onFrame: frame => {
        if ((frame as { data_type?: string }).data_type === 'file_chunk') recall();
        return options.onFrame(frame);
      },
    }));
    useTransport(value);
    await expect(resolveOneBotMedia(await registerOneBotMedia(descriptor), chatId)).rejects.toThrow('qq_media_source_recalled');
    expect(value.streamAction).toHaveBeenCalledTimes(1);
  });
  it('returns a required callback bound to source A, not a later task/message B', async () => {
    useTransport(); const handle = await registerOneBotMedia(descriptor);
    const file = await resolveOneBotMedia(handle, chatId);
    recall({ conversation: group, id: '2' }); // A different task anchor is not the asset source.
    expect(() => file.assertAvailable()).not.toThrow();
    recall();
    expect(() => file.assertAvailable()).toThrow('qq_media_source_recalled');
  });
  it('keeps source identity isolated from matching native IDs in another account/chat', async () => {
    useTransport(); const file = await resolveOneBotMedia(await registerOneBotMedia(descriptor), chatId);
    recall({ conversation: { ...group, id: '70002' }, id: descriptor.message.id });
    recall({ conversation: { ...group, accountId: '80002' }, id: descriptor.message.id });
    expect(() => file.assertAvailable()).not.toThrow();
  });
  it('fails closed if the recall table is unavailable before or after a download', async () => {
    const { value } = useTransport(); const handle = await registerOneBotMedia(descriptor);
    const file = await resolveOneBotMedia(handle, chatId);
    db.exec('DROP TABLE onebot_message_recalls');
    expect(() => file.assertAvailable()).toThrow('qq_media_availability_unknown');
    await expect(resolveOneBotMedia(handle, chatId)).rejects.toThrow('qq_media_availability_unknown');
    expect(value.streamAction).toHaveBeenCalledTimes(1);
  });
  it('fails closed on callback database errors without leaking their details', async () => {
    useTransport(); const file = await resolveOneBotMedia(await registerOneBotMedia(descriptor), chatId);
    mocks.getDb.mockImplementationOnce(() => { throw new Error('private-database-path'); });
    expect(() => file.assertAvailable()).toThrow('qq_media_availability_unknown');
  });
  it('also rechecks source recall after an HTTP download', async () => {
    httpReplies({ chunks: [png] });
    const request = mocks.request.getMockImplementation()!;
    mocks.request.mockImplementation((...args) => {
      const result = request(...args); recall(); return result;
    });
    await expect(resolveOneBotMedia(await registerOneBotMedia({ ...descriptor, assetId: undefined,
      url: 'https://gchat.qpic.cn/image' }), chatId)).rejects.toThrow('qq_media_source_recalled');
  });
  it('does not keep a resolved capability alive after its original TTL', async () => {
    useTransport(); const file = await resolveOneBotMedia(await registerOneBotMedia(descriptor), chatId);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + ONEBOT_MEDIA_TTL_SEC * 1000 + 1);
    expect(() => file.assertAvailable()).toThrow('qq_media_expired');
  });
});

interface Reply { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; complete?: boolean; neverEnd?: boolean; }
function httpReplies(...replies: Reply[]) {
  mocks.request.mockImplementation((_options, callback) => {
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, complete: true, destroy: vi.fn() });
    const request = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn(() => queueMicrotask(() => {
      const reply = replies.shift() ?? {};
      response.statusCode = reply.status ?? 200; response.headers = reply.headers ?? {}; response.complete = reply.complete ?? true;
      callback(response);
      if (response.destroy.mock.calls.length) return;
      for (const part of reply.chunks ?? [png]) response.emit('data', part);
      if (!reply.neverEnd) { response.emit('end'); response.emit('close'); }
    })) });
    return request;
  });
}
describe('QQ media binary HTTP boundary', () => {
  it.each(['file:///tmp/a', 'http://127.0.0.1/a', 'https://example.com/a', 'https://qpic.cn.evil.test/a',
    'https://user:password@qpic.cn/a', 'https://qpic.cn:8443/a', 'http://[::ffff:7f00:1]/a'])('refuses %s', url => {
    expect(() => assertOneBotMediaUrl(url)).toThrow('qq_media_url_refused');
  });
  it('pins the socket to validated DNS while preserving Host and TLS SNI', async () => {
    httpReplies({ chunks: [png.subarray(0, 4), png.subarray(4)] });
    expect(await downloadOneBotMediaUrl('https://gchat.qpic.cn/image?token=secret')).toEqual(png);
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ hostname: '8.8.8.8', servername: 'gchat.qpic.cn',
      rejectUnauthorized: true, headers: { Host: 'gchat.qpic.cn', 'Accept-Encoding': 'identity' }, agent: false }), expect.any(Function));
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });
  it('rejects mixed private DNS answers before opening a socket', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    await expect(downloadOneBotMediaUrl('https://qpic.cn/a')).rejects.toThrow('qq_media_address_refused');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('revalidates redirected hosts and never connects to private or unrelated destinations', async () => {
    httpReplies({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    await expect(downloadOneBotMediaUrl('https://qpic.cn/a')).rejects.toThrow('qq_media_url_refused');
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('pins DNS separately on every allowed redirect', async () => {
    httpReplies({ status: 302, headers: { location: 'https://gchat.qpic.cn/b' } }, { chunks: [png] });
    expect(await downloadOneBotMediaUrl('https://qpic.cn/a')).toEqual(png);
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
  });
  it.each([
    { headers: { 'content-length': '1000' } }, { headers: { 'content-encoding': 'gzip' } },
    { chunks: [Buffer.alloc(3), Buffer.alloc(4)] },
  ])('rejects oversized or compressed bodies instead of returning truncated bytes', async reply => {
    httpReplies(reply);
    await expect(downloadOneBotMediaUrl('https://qpic.cn/a', { maxBytes: 5 })).rejects.toThrow('qq_media_too_large');
  });
  it('rejects a premature stream close', async () => {
    httpReplies({ chunks: [png], complete: false });
    await expect(downloadOneBotMediaUrl('https://qpic.cn/a')).rejects.toThrow('qq_media_incomplete_stream');
  });
  it('cancels the HTTP request on the shared total deadline', async () => {
    vi.useFakeTimers(); httpReplies({ neverEnd: true });
    const pending = downloadOneBotMediaUrl('https://qpic.cn/a', { timeoutMs: 100 });
    const assertion = expect(pending).rejects.toThrow('qq_media_aborted');
    await vi.advanceTimersByTimeAsync(101); await assertion;
    expect(mocks.request.mock.results[0]?.value.destroy).toHaveBeenCalled();
  });
});
