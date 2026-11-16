import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  cfg: { CODEACT_BANNED_WORDS: [], ONEBOT_MEDIA_ENABLED: true },
  resolve: vi.fn(), media: vi.fn(), telegram: vi.fn(), recalled: vi.fn(),
  answered: vi.fn(), context: vi.fn(), events: vi.fn(), holdWrite: vi.fn(), compareDelete: vi.fn(),
  held: new Map<string, string>(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => f.cfg }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ hsetnx: f.holdWrite, eval: f.compareDelete }) }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => { throw new Error('unexpected DB access'); } }));
// This fixture exercises ordinary QQ delivery, outside owner assignments.
vi.mock('../../../src/platform/onebot-assignment-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/platform/onebot-assignment-store.js')>(),
  assertOneBotAssignmentTask: () => null,
}));
vi.mock('../../../src/pipeline/correction-cooldown.js', () => ({
  isCorrectionCooling: async () => false, isLocallyCorrectionCooling: () => false,
}));
vi.mock('../../../src/platform/onebot-notices.js', () => ({ isOneBotMessageRecalled: f.recalled }));
vi.mock('../../../src/platform/onebot-media.js', () => ({ resolveOneBotMedia: f.resolve }));
vi.mock('../../../src/platform/outbound.js', () => ({
  sendPlatformMedia: f.media,
  PlatformOutboundError: class extends Error {
    readonly delivery = 'not_sent';
    constructor(readonly code: string) { super(code); }
  },
}));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: f.telegram, sendFile: f.telegram, sendPhoto: f.telegram,
  sendSticker: f.telegram, reactToMessage: f.telegram, sendChatAction: f.telegram,
}));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: f.answered, answeredTimestamps: vi.fn(async () => []) }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ addAssistant: f.context }));
vi.mock('../../../src/agent/cognitive-events.js', () => ({ appendCognitiveEvent: f.events }));
vi.mock('../../../src/agent/task-runtime-events.js', () => ({ emitTaskRuntimeEvent: vi.fn() }));
vi.mock('../../../src/agent/task-progress.js', () => ({ markTaskVisible: vi.fn() }));
vi.mock('../../../src/agent/predictions.js', () => ({ recordPrediction: vi.fn() }));
vi.mock('../../../src/agent/social-predictions.js', () => ({ recordSocialDeliveryPrediction: vi.fn() }));
vi.mock('../../../src/tracking/self-history.js', () => ({ recordSelfReply: vi.fn() }));
vi.mock('../../../src/tracking/person-identity.js', () => ({ getPersonIdentity: () => null, buildCrossGroupInjection: () => '' }));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ getReadyStickersByIntent: () => [] }));
vi.mock('../../../src/memory/chroma.js', () => ({ searchMemory: vi.fn(), searchMemoryByUser: vi.fn() }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/sandbox/paths.js', () => ({ resolveSandboxRoot: () => '/synthetic-sandbox' }));

import { createHostApi } from '../../../src/subagent/host-api.js';
import { codeActMethodsForChat } from '../../../src/subagent/capability-prompt.js';
import { selectCodeActCapabilities } from '../../../src/sandbox/codeact/capabilities.js';

const chatId = 2 ** 52 + 101;
const anchor = 2 ** 52 + 102;
const sibling = 2 ** 52 + 103;
const receipt = 2 ** 52 + 104;
const taskId = 'synthetic-qq-attachment';
function host(options: Partial<Parameters<typeof createHostApi>[1]> = {}) {
  return createHostApi(chatId, { taskId, onEnd: vi.fn(), defaultReplyTo: anchor, relatedQuoteIds: [sibling], ...options });
}

beforeEach(() => {
  vi.clearAllMocks();
  f.cfg.ONEBOT_MEDIA_ENABLED = true;
  f.held.clear();
  f.recalled.mockReset().mockReturnValue(false);
  f.resolve.mockReset().mockResolvedValue({ bytes: Buffer.from('synthetic file'), fileName: 'report.txt', mimeType: 'text/plain', assertAvailable() {} });
  f.media.mockReset().mockResolvedValue(receipt);
  f.context.mockReset().mockResolvedValue(undefined);
  f.answered.mockReset().mockResolvedValue(undefined);
  f.holdWrite.mockReset().mockImplementation(async (_key: string, id: string, record: string) => {
    if (f.held.has(id)) return 0;
    f.held.set(id, record); return 1;
  });
  f.compareDelete.mockReset().mockImplementation(async (_script: string, _count: number, _key: string, id: string, expected: string) => {
    if (f.held.get(id) !== expected) return 0;
    f.held.delete(id); return 1;
  });
});

describe('QQ attachment actual host boundary', () => {
  it('exports attachments only through enabled QQ capability selection', () => {
    const attachmentNames = ['telegram.readFile', 'telegram.sendFile', 'telegram.sendPhoto', 'telegram.sendTextFile'];
    const enabled = selectCodeActCapabilities(host(), codeActMethodsForChat(chatId));
    for (const name of attachmentNames) expect(enabled.has(name)).toBe(true);
    f.cfg.ONEBOT_MEDIA_ENABLED = false;
    const disabled = selectCodeActCapabilities(host(), codeActMethodsForChat(chatId));
    for (const name of attachmentNames) expect(disabled.has(name)).toBe(false);
    f.cfg.ONEBOT_MEDIA_ENABLED = true;
    const tg = createHostApi(123, { onEnd: vi.fn() });
    const telegram = selectCodeActCapabilities(tg, codeActMethodsForChat(123));
    for (const name of attachmentNames) expect(telegram.has(name)).toBe(false);
    expect(f.media).not.toHaveBeenCalled();
    expect(f.telegram).not.toHaveBeenCalled();
  });

  it('claims delivery before upload and records only an acknowledged QQ attachment', async () => {
    f.media.mockImplementation(async () => {
      expect(JSON.parse(f.held.get(taskId)!)).toMatchObject({ taskId, chatId, code: 'delivery_in_flight' });
      expect(f.context).not.toHaveBeenCalled();
      expect(f.answered).not.toHaveBeenCalled();
      return receipt;
    });
    const api = host();
    const capabilities = selectCodeActCapabilities(api, codeActMethodsForChat(chatId));
    await expect(capabilities.get('telegram.sendTextFile')!('../../report.txt', '合成报告')).resolves.toEqual({ messageId: receipt });
    expect(f.media).toHaveBeenCalledExactlyOnceWith(chatId, 'file', Buffer.from('合成报告'), 'report.txt',
      { replyToId: anchor, caption: undefined, beforeSend: expect.any(Function) });
    expect(f.context).toHaveBeenCalledExactlyOnceWith(chatId, { messageId: receipt, textContent: '[file] report.txt' }, undefined);
    expect(f.answered.mock.calls).toEqual([[chatId, anchor], [chatId, sibling]]);
    expect(f.events).toHaveBeenCalledWith(expect.objectContaining({ type: 'bot_delivery', fact: expect.objectContaining({ platform: 'qq', kind: 'attachment', messageId: receipt }) }));
    expect(f.held.size).toBe(0);
    expect(api.runtime.didProduce()).toBe(true);
    expect(api.runtime.didProduceFinal()).toBe(false);
    expect(f.telegram).not.toHaveBeenCalled();
  });

  it('binds reads to the current chat and never turns an asset resolution failure into delivery', async () => {
    const api = host();
    await expect(api.telegram.readFile!('qq-media:current')).resolves.toMatchObject({ text: 'synthetic file' });
    expect(f.resolve).toHaveBeenCalledWith('qq-media:current', chatId, { maxBytes: 1024 * 1024 });
    const denied = Object.assign(new Error('media_wrong_scope'), { delivery: 'not_sent' });
    f.resolve.mockRejectedValue(denied);
    await expect(api.telegram.sendFile('qq-media:foreign')).rejects.toBe(denied);
    expect(f.resolve).toHaveBeenLastCalledWith('qq-media:foreign', chatId, { maxBytes: 50 * 1024 * 1024 });
    expect(f.holdWrite).not.toHaveBeenCalled();
    expect(f.media).not.toHaveBeenCalled();
    expect(f.telegram).not.toHaveBeenCalled();
    expect(api.runtime.didProduce()).toBe(false);
  });

  it('serializes attachment sends and closes all later sends after an unknown receipt', async () => {
    let rejectSend!: (error: unknown) => void;
    f.media.mockImplementation(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
    const onUnknown = vi.fn();
    const api = host({ onDeliveryUnknown: onUnknown });
    const first = api.telegram.sendTextFile!('one.txt', 'first');
    const second = api.telegram.sendTextFile!('two.txt', 'second');
    const settled = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(f.media).toHaveBeenCalledTimes(1));
    rejectSend(Object.assign(new Error('synthetic timeout'), { code: 'request_timeout', delivery: 'unknown' }));
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    await expect(api.telegram.sendText('do not retry')).rejects.toThrow('delivery_unknown_task_closed');
    await expect(api.telegram.sendFile('qq-media:current')).rejects.toThrow('delivery_unknown_task_closed');
    expect(f.media).toHaveBeenCalledTimes(1);
    expect(f.telegram).not.toHaveBeenCalled();
    expect(f.held.has(taskId)).toBe(true);
    expect(onUnknown).toHaveBeenCalledExactlyOnceWith('request_timeout');
    expect(f.context).not.toHaveBeenCalled();
    expect(f.answered).not.toHaveBeenCalled();
    expect(api.runtime.hasUnknownDelivery?.()).toBe(true);
    expect(api.runtime.didProduce()).toBe(false);
    expect(api.runtime.didProduceFinal()).toBe(false);
  });

  it('sends nothing when the durable pre-send claim cannot be written', async () => {
    f.holdWrite.mockRejectedValue(new Error('synthetic Redis failure'));
    const api = host();
    await expect(api.telegram.sendTextFile!('one.txt', 'first')).rejects.toMatchObject({ code: 'delivery_intent_store_unavailable', delivery: 'not_sent' });
    expect(f.media).not.toHaveBeenCalled();
    expect(f.telegram).not.toHaveBeenCalled();
    expect(f.context).not.toHaveBeenCalled();
    expect(api.runtime.didProduce()).toBe(false);
  });

  it('checks recall before reading and again after asynchronous asset resolution', async () => {
    const api = host();
    f.recalled.mockReturnValue(true);
    await expect(api.telegram.readFile!('qq-media:current')).rejects.toThrow('qq_message_recalled');
    expect(f.resolve).not.toHaveBeenCalled();
    f.recalled.mockReturnValue(false);
    let finish!: (file: { bytes: Buffer; fileName: string; mimeType: string; assertAvailable(): void }) => void;
    f.resolve.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const sending = api.telegram.sendFile('qq-media:current');
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledOnce());
    f.recalled.mockReturnValue(true);
    finish({ bytes: Buffer.from('old'), fileName: 'old.txt', mimeType: 'text/plain', assertAvailable() {} });
    await expect(sending).rejects.toThrow('qq_message_recalled');
    expect(f.holdWrite).not.toHaveBeenCalled();
    expect(f.media).not.toHaveBeenCalled();
  });

  it('keeps the host file budget and does not count known failed attempts as output', async () => {
    f.media.mockRejectedValue(Object.assign(new Error('not ready'), { delivery: 'not_sent' }));
    const api = host({ maxFileSends: 1 });
    await expect(api.telegram.sendTextFile!('one.txt', 'first')).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(f.held.size).toBe(0);
    await expect(api.telegram.sendTextFile!('two.txt', 'second')).rejects.toMatchObject({ code: 'qq_attachment_limit' });
    expect(f.media).toHaveBeenCalledOnce();
    expect(api.runtime.hasUnknownDelivery?.()).toBe(false);
    expect(api.runtime.didProduce()).toBe(false);
  });

  it('flushes an unawaited attachment until the actual receipt arrives', async () => {
    let finish!: (id: number) => void;
    f.media.mockImplementation(() => new Promise<number>(resolve => { finish = resolve; }));
    const api = host();
    const pending = api.telegram.sendTextFile!('pending.txt', 'pending');
    await vi.waitFor(() => expect(f.media).toHaveBeenCalledOnce());
    const drained = vi.fn();
    const flushing = api.runtime.flushBookkeeping().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    expect(api.runtime.didProduce()).toBe(false);
    finish(receipt);
    await Promise.all([pending, flushing]);
    expect(drained).toHaveBeenCalledOnce();
    expect(api.runtime.didProduce()).toBe(true);
    expect(f.context).toHaveBeenCalledOnce();
    expect(f.held.size).toBe(0);
  });
});
