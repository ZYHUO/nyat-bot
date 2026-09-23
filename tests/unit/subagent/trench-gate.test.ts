import { describe, expect, it, vi, beforeEach } from 'vitest';

// 论文 §1.2：`canSpeakActively()` 曾经在全仓库只有一个引用——它自己的定义。
// 6条/h+90s 实际靠发送后的 fire-and-forget 计数执行，发送前没有任何东西能拦。
// 这个测试锁死新行为：**发送前**、主动发言、deprived 时一定不出去。

const sendMessage = vi.fn(async (_c: number, _t: string, _r?: number) => 4242);
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...(a as [number, string, number?])),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
}));

const budgetState = { allowed: true, cooldownLeft: 0, addressedLeft: 0 };
vi.mock('../../../src/nyatos/budget.js', () => ({
  canSpeakActively: async () => budgetState.allowed,
  activeSpeechCooldownRemainingSec: async () => budgetState.cooldownLeft,
  addressedSpeechCooldownRemainingSec: async () => budgetState.addressedLeft,
  spendParticipation: async () => null,
  markActiveSpeech: async () => undefined,
  getParticipationBudget: async () => null,
  renderParticipationBudget: () => '',
}));

const envMock = { TRENCH_GATE_ENABLED: true, CODEACT_BANNED_WORDS: [] };
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));
vi.mock('../../../src/memory/chroma.js', () => ({
  searchMemory: vi.fn(async () => []), searchMemoryByUser: vi.fn(async () => []), memorizeMessage: vi.fn(async () => undefined),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  addAssistant: vi.fn(async () => undefined), getRecent: vi.fn(async () => []),
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ set: vi.fn(async () => 'OK') }) }));
vi.mock('../../../src/meta/timing-adapter.js', () => ({ noteMetaBotReply: vi.fn(async () => undefined) }));
vi.mock('../../../src/meta/answered.js', () => ({ markMessageAnswered: vi.fn(async () => undefined), answeredTimestamps: vi.fn(async () => [] as number[]) }));

const { createHostApi } = await import('../../../src/subagent/host-api.js');

beforeEach(() => {
  sendMessage.mockClear();
  budgetState.allowed = true;
  budgetState.cooldownLeft = 0;
  budgetState.addressedLeft = 0;
  envMock.TRENCH_GATE_ENABLED = true;
});

function host(chatId: number, defaultReplyTo?: number) {
  return createHostApi(chatId, { onEnd: () => {}, taskId: 'g1', maxTextSends: 4, ...(defaultReplyTo === undefined ? {} : { defaultReplyTo }) });
}

describe('L1 沟壁 · 发送前硬闸', () => {
  it('主动发言超预算 → 不发送，且把事实抛回给模型', async () => {
    budgetState.allowed = false;
    await expect(host(-100).telegram.sendText('群里好久没说话了')).rejects.toThrow(/未发送/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('刚说过话（间隔未到）→ 不发送', async () => {
    budgetState.cooldownLeft = 65;
    await expect(host(-100).telegram.sendText('再说一句')).rejects.toThrow(/秒前刚在这个群说过话/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('被叫到的消息不受**计数预算**限制（无视直接提问是另一种失败）', async () => {
    budgetState.allowed = false;
    budgetState.cooldownLeft = 999;
    // 有 replyTo 锚点 = 有人在叫我
    await host(-100, 321).telegram.sendText('在的喵', 321);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  // 2026-09-21：但"被叫到"不再意味着"没有间隔"。生产流量几乎全在这条路上
  // （近3天 2702 次 sendText：1356 显式 replyTo + 1340 只有任务默认锚点），
  // 而最小间隔原来只拦主动发言 —— 那条路一点间隔都没有，5 分钟窗 max=20。
  it('被叫到的回复也受最小间隔限制（只是尺子更松）', async () => {
    budgetState.allowed = false;      // 计数额度照样豁免
    budgetState.cooldownLeft = 999;   // 主动间隔照样豁免
    budgetState.addressedLeft = 12;   // 但被叫间隔不豁免
    await expect(host(-100, 321).telegram.sendText('在的喵，刚在忙别的', 321)).rejects.toThrow(/连得太密/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('被叫间隔为 0 时照发（默认关闭或刚过间隔）', async () => {
    budgetState.addressedLeft = 0;
    await host(-100, 321).telegram.sendText('来啦来啦，刚才在翻记录', 321);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('DM 不受群预算限制', async () => {
    budgetState.allowed = false;
    await host(6251541967).telegram.sendText('主人怎么啦');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('flag 关时退回旧行为（照发）——可回滚', async () => {
    envMock.TRENCH_GATE_ENABLED = false;
    budgetState.allowed = false;
    await host(-100).telegram.sendText('还是要说');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('被拦的措辞是身体感受，不是错误码', async () => {
    budgetState.allowed = false;
    const err = await host(-100).telegram.sendText('x').catch((e) => e as Error);
    const msg = err.message;
    expect(msg).toContain('嗓子');
    expect(msg).not.toMatch(/Error|undefined|\[object/);
  });
});
