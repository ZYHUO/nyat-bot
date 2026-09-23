import { describe, expect, it, vi, beforeEach } from 'vitest';

// 这个会话里反复出现的失败形态是"接上了但没接在活的那条路上"。
// envelope iva已单测，这里要证明的是 **host-api 真的会调它**。

const sendMessage = vi.fn(async () => 4242);
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...(a as [number, string, number?])),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
}));

const checkEnvelope = vi.fn(async () => ({ ok: true, mode: 'off' }));
const spendEnvelope = vi.fn(async () => {});
vi.mock('../../../src/nyatos/envelope.js', () => ({ checkEnvelope: (...a: unknown[]) => checkEnvelope(...a), spendEnvelope: (...a: unknown[]) => spendEnvelope(...a), observeEnvelopeShadow: () => {}, renderEnvelopeBlock: () => 'blocked' }));

const budgetState = { allowed: true, cooldownLeft: 0 };
vi.mock('../../../src/nyatos/budget.js', () => ({
  canSpeakActively: async () => budgetState.allowed,
  activeSpeechCooldownRemainingSec: async () => budgetState.cooldownLeft,
  spendParticipation: async () => null, markActiveSpeech: async () => undefined,
  getParticipationBudget: async () => null, renderParticipationBudget: () => '',
}));
const envMock = { TRENCH_GATE_ENABLED: false, CODEACT_BANNED_WORDS: [] };
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));
vi.mock('../../../src/memory/chroma.js', () => ({ searchMemory: vi.fn(async () => []), searchMemoryByUser: vi.fn(async () => []), memorizeMessage: vi.fn(async () => undefined) }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ addAssistant: vi.fn(async () => undefined), getRecent: vi.fn(async () => []) }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ set: vi.fn(async () => 'OK') }) }));
vi.mock('../../../src/meta/timing-adapter.js', () => ({ noteMetaBotReply: vi.fn(async () => undefined) }));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: vi.fn(async () => undefined),
  answeredTimestamps: vi.fn(async () => [] as number[]) }));

const { createHostApi } = await import('../../../src/subagent/host-api.js');
beforeEach(() => { sendMessage.mockClear(); checkEnvelope.mockClear(); spendEnvelope.mockClear(); checkEnvelope.mockImplementation(async () => ({ ok: true, mode: 'off' })); });

describe('host-api 真的会调 envelope', () => {
  it('每次 sendText 都检查包络', async () => {
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'e1', maxTextSends: 3 });
    await host.telegram.sendText('第一句问候', 111);
    expect(checkEnvelope).toHaveBeenCalledWith(-100, true);   // 带锚点 = addressed
  });

  it('发送成功后记账进突发窗口', async () => {
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'e2', maxTextSends: 3 });
    await host.telegram.sendText('第二句问候', 111);
    expect(spendEnvelope).toHaveBeenCalledWith(-100);
  });

  it('enforce 且爆了 → 不发送', async () => {
    checkEnvelope.mockImplementation(async () => ({ ok: false, mode: 'enforce', why: 'blocked_by_burst', retryAfterSec: 60 }));
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'e3', maxTextSends: 3 });
    await expect(host.telegram.sendText('第三句问候', 111)).rejects.toThrow(/blocked|未发送|回得太密/);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(spendEnvelope).not.toHaveBeenCalled();   // 没发就不记账
  });

  it('shadow 且爆了 → 照发（只观测）', async () => {
    checkEnvelope.mockImplementation(async () => ({ ok: false, mode: 'shadow', why: 'blocked_by_burst', retryAfterSec: 60 }));
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'e4', maxTextSends: 3 });
    await host.telegram.sendText('第四句问候', 111);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(spendEnvelope).toHaveBeenCalled();
  });
});
