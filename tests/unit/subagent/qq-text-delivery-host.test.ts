import { beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({ send: vi.fn(), onSend: vi.fn(), answered: vi.fn(), context: vi.fn(),
  held: new Map<string, string>(), chat: 2 ** 52 + 700, recall: vi.fn() }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ CODEACT_BANNED_WORDS: [], ONEBOT_MEDIA_ENABLED: false }) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: f.send, sendSticker: vi.fn(), reactToMessage: vi.fn(), sendChatAction: vi.fn(async () => {}) }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => 2 ** 52 + 1, getBotDisplayName: () => 'Bot' }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => { throw new Error('unexpected DB access'); } }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ get: async () => null, set: async () => 'OK',
  hsetnx: async (_key: string, id: string, value: string) => { if (f.held.has(id)) return 0; f.held.set(id, value); return 1; },
  eval: async (_script: string, _count: number, _key: string, id: string, expected: string) => {
    if (f.held.get(id) !== expected) return 0; f.held.delete(id); return 1;
  },
}) }));
vi.mock('../../../src/platform/onebot-notices.js', () => ({ isOneBotMessageRecalled: f.recall }));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: f.answered, answeredTimestamps: async () => [] }));
vi.mock('../../../src/meta/speaker-burst.js', () => ({ clearSpeakerBurst: vi.fn(async () => {}) }));
vi.mock('../../../src/meta/timing-adapter.js', () => ({ noteMetaBotReply: vi.fn(async () => {}) }));
vi.mock('../../../src/meta/session-digest.js', () => ({ searchDigests: () => [] }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: async () => [], addAssistant: f.context }));
vi.mock('../../../src/pipeline/reply/anti-repeat.js', () => ({ checkNearDuplicate: async () => ({ isNearDuplicate: false }) }));
vi.mock('../../../src/pipeline/reply/segmenter.js', () => ({ REPLY_SPLIT_CHAR_THRESHOLD: 1000,
  segmentReply: (text: string) => ({ segments: [text] }), calculateTypingDelay: () => 0 }));
vi.mock('../../../src/memory/chroma.js', () => ({ searchMemory: async () => [], searchMemoryByUser: async () => [], memorizeMessage: async () => {} }));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ getReadyStickersByIntent: () => [] }));
vi.mock('../../../src/tracking/person-identity.js', () => ({ getPersonIdentity: () => null, buildCrossGroupInjection: () => '' }));
vi.mock('../../../src/tracking/self-history.js', () => ({ recordSelfReply: vi.fn(), getRecentBotTextsInChat: () => [] }));
vi.mock('../../../src/agent/cognitive-events.js', () => ({ appendCognitiveEvent: vi.fn() }));
vi.mock('../../../src/agent/cognitive-debts.js', () => ({ resolveOpenDebtsByTaskWithEvidence: vi.fn() }));
vi.mock('../../../src/agent/task-evidence-store.js', () => ({ saveTaskEvidence: vi.fn() }));
vi.mock('../../../src/agent/task-runtime-events.js', () => ({ emitTaskRuntimeEvent: vi.fn() }));
vi.mock('../../../src/agent/task-progress.js', () => ({ markTaskVisible: vi.fn() }));
vi.mock('../../../src/agent/predictions.js', () => ({ recordPrediction: vi.fn() }));
vi.mock('../../../src/agent/social-predictions.js', () => ({ recordSocialDeliveryPrediction: vi.fn() }));
vi.mock('../../../src/nyatos/envelope.js', () => ({ checkEnvelope: async () => ({ ok: true, mode: 'off' }), spendEnvelope: vi.fn() }));
vi.mock('../../../src/nyatos/trench.js', () => ({ releasePressure: vi.fn() }));
vi.mock('../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../src/metrics/social-ledger.js', () => ({ recordReplySent: vi.fn() }));
vi.mock('../../../src/subagent/post-task-window.js', () => ({ noteBotSpoke: vi.fn() }));
vi.mock('../../../src/sandbox/paths.js', () => ({ resolveSandboxRoot: () => '/synthetic-sandbox' }));

import { createHostApi } from '../../../src/subagent/host-api.js';
const anchor = 2 ** 52 + 50;
function setup(maxTextSends = 3, chatId = f.chat) {
  return createHostApi(chatId, { taskId: `synthetic-text-${chatId}`, defaultReplyTo: Math.abs(chatId) < 2 ** 52 ? 12345 : anchor,
    maxTextSends, onSend: f.onSend, onEnd: vi.fn() });
}
beforeEach(() => {
  vi.clearAllMocks(); f.held.clear(); f.chat++;
  f.recall.mockReturnValue(false); f.answered.mockResolvedValue(undefined); f.context.mockResolvedValue(undefined);
  f.send.mockReset().mockResolvedValue(2 ** 52 + 80);
});

describe('QQ host text bubbles, optional quote and confirmed budget', () => {
  it('omits visible quotes while retaining answered bookkeeping and two real bubble receipts', async () => {
    const api = setup();
    await api.telegram.sendText('先保留原来的思路。\n接下来只补测试。');
    expect(f.send.mock.calls.map(call => call.slice(0, 3))).toEqual([
      [f.chat, '先保留原来的思路。', undefined], [f.chat, '接下来只补测试。', undefined],
    ]);
    expect(f.onSend).toHaveBeenCalledTimes(2);
    expect(f.answered).toHaveBeenCalledWith(f.chat, anchor);
    expect(api.runtime.didSendText()).toBe(true);
  });
  it('uses an explicit permitted quote on the first bubble only; rejects foreign quotes before send', async () => {
    const api = setup();
    await expect(api.telegram.sendText('这个引用不属于当前任务', anchor + 1)).rejects.toThrow('引用只能选择本任务');
    expect(f.send).not.toHaveBeenCalled();
    await api.telegram.sendText('这边已经确认了。\n下一步可以继续。', anchor);
    expect(f.send.mock.calls.map(call => call[2])).toEqual([anchor, undefined]);
  });
  it('preserves Telegram fallback quotation and its existing per-call budget', async () => {
    const api = setup(2, -1001234567890);
    await api.telegram.sendText('Telegram继续使用原来的触发消息引用');
    expect(f.send).toHaveBeenCalledWith(-1001234567890, expect.any(String), 12345, undefined,
      expect.objectContaining({ markAnswered: false, onReceipt: expect.any(Function) }));
    expect(f.onSend).toHaveBeenCalledOnce();
  });
  it('rejects oversized content and insufficient whole-reply budget before the first bubble', async () => {
    const api = setup(1);
    await expect(api.telegram.sendText('字'.repeat(241))).rejects.toThrow('压缩完整回答');
    await expect(api.telegram.sendText('第一部分已经确认。\n第二部分还要检查。')).rejects.toThrow('sendText_limit:1');
    expect(f.send).not.toHaveBeenCalled(); expect(f.onSend).not.toHaveBeenCalled();
  });
  it('does not let parallel calls overbook a two-bubble task', async () => {
    const api = setup(2);
    let finish!: (id: number) => void;
    f.send.mockImplementationOnce(() => new Promise<number>(resolve => { finish = resolve; }));
    const first = api.telegram.sendText('先说明当前状况。\n然后补充下一步。');
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    await expect(api.telegram.sendText('另一个并发调用不能抢占剩余额度')).rejects.toThrow('sendText_limit:2');
    finish(2 ** 52 + 81); await first;
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.onSend).toHaveBeenCalledTimes(2);
  });
  it('keeps the first acknowledged bubble charged when a later receipt is unknown and never retries', async () => {
    const api = setup(3);
    f.send.mockResolvedValueOnce(2 ** 52 + 82).mockRejectedValueOnce(Object.assign(new Error('timeout'), { delivery: 'unknown', code: 'request_timeout' }));
    await expect(api.telegram.sendFinal('第一部分可以交付。\n下一部分还没确认。')).rejects.toMatchObject({ delivery: 'unknown' });
    expect(f.onSend).toHaveBeenCalledOnce(); expect(api.runtime.didSendText()).toBe(true);
    expect(api.runtime.didProduceFinal()).toBe(false); expect(api.runtime.hasUnknownDelivery?.()).toBe(true);
    await expect(api.telegram.sendText('不能再补发')).rejects.toThrow('delivery_unknown_task_closed');
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('releases an unsent reservation after a known transport rejection', async () => {
    const api = setup(2);
    f.send.mockRejectedValueOnce(Object.assign(new Error('not ready'), { delivery: 'not_sent' }));
    await expect(api.telegram.sendText('这一次尚未发送')).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(f.onSend).not.toHaveBeenCalled();
    await api.telegram.sendText('恢复后先检查。\n然后确认结果。');
    expect(f.onSend).toHaveBeenCalledTimes(2);
  });
});
