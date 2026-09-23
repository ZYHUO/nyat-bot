import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * task 级 burst 闸的**行为**测试（round 171 补）。
 *
 * 前面 task-burst-gate.test.ts 查的是源码结构（round 142 的教训：文本在场
 * 不等于机制在跑）。这里**真的调用** host.telegram.sendText 两次，断言第二次
 * 抛错——AGENTS.md：「A grep guard proves the string, not the logic.」
 *
 * 现场：一个任务 51 秒内 4 次调用 → 11 个气泡，用户抱怨"说话太应激"。
 */

const store = new Map<string, string>();
const sendMessage = vi.fn(async () => 4242);

vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...(a as [number, string, number?])),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
}));

vi.mock('../../../src/nyatos/envelope.js', () => ({
  checkEnvelope: vi.fn(async () => ({ ok: true, mode: 'off' })),
  spendEnvelope: vi.fn(async () => {}),
  observeEnvelopeShadow: () => {},
  renderEnvelopeBlock: () => 'blocked',
}));

vi.mock('../../../src/nyatos/budget.js', () => ({
  canSpeakActively: async () => true,
  activeSpeechCooldownRemainingSec: async () => 0,
  addressedSpeechCooldownRemainingSec: async () => 0,
  spendParticipation: async () => null,
  markActiveSpeech: async () => undefined,
  getParticipationBudget: async () => null,
  renderParticipationBudget: () => '',
}));

// 关键：这里给 redis 一个**真能用的** get/set（前面几个测试只 mock 了 set，
// 所以 burst 闸读不到上次时间，行为测不了）。store 用 Map 冒充。
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => { store.set(k, v); return 'OK'; },
    del: async (k: string) => { store.delete(k); return 1; },
  }),
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({ TRENCH_GATE_ENABLED: true, CODEACT_BANNED_WORDS: [] }),
}));
vi.mock('../../../src/memory/chroma.js', () => ({
  searchMemory: vi.fn(async () => []), searchMemoryByUser: vi.fn(async () => []),
  memorizeMessage: vi.fn(async () => undefined),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  addAssistant: vi.fn(async () => undefined), getRecent: vi.fn(async () => []),
}));
vi.mock('../../../src/meta/timing-adapter.js', () => ({ noteMetaBotReply: vi.fn(async () => undefined) }));
vi.mock('../../../src/meta/answered.js', () => ({
  markMessageAnswered: vi.fn(async () => undefined),
  answeredTimestamps: vi.fn(async () => [] as number[]),
}));

const { createHostApi } = await import('../../../src/subagent/host-api.js');

beforeEach(() => { store.clear(); sendMessage.mockClear(); });

describe('task 级 burst 闸（行为）', () => {
  it('① 同一任务紧接着第二次开口 → 抛回模型，且没有真的发出去', async () => {
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'b1', maxTextSends: 3 });
    // 第一次：没有历史，应该发得出去
    await expect(host.telegram.sendText('第一句', 111)).resolves.toBeTruthy();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // 第二次（同一个 taskId，同一秒）：应该被闸拦下
    await expect(host.telegram.sendText('第二句', 111)).rejects.toThrow(/未发送|秒前才在这个群说过话/);
    expect(sendMessage).toHaveBeenCalledTimes(1);   // 没有第二次真发
  });

  it('② 换一个任务（不同 taskId）不受影响', async () => {
    const h1 = createHostApi(-100, { onEnd: () => {}, taskId: 'b2', maxTextSends: 3 });
    const h2 = createHostApi(-100, { onEnd: () => {}, taskId: 'b3', maxTextSends: 3 });
    await expect(h1.telegram.sendText('A', 111)).resolves.toBeTruthy();
    await expect(h2.telegram.sendText('B', 111)).resolves.toBeTruthy();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('③ 没有 taskId（legacy / failsafe 路径）完全不受闸', async () => {
    const host = createHostApi(-100, { onEnd: () => {}, maxTextSends: 3 });
    await expect(host.telegram.sendText('一', 111)).resolves.toBeTruthy();
    await expect(host.telegram.sendText('二', 111)).resolves.toBeTruthy();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('④ 距上次超过阈值就放行（阈值 12s，这里直接把键写到 60s 前）', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 60);
    store.set('xxb:agent:lastsend:b4', old);
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'b4', maxTextSends: 3 });
    await expect(host.telegram.sendText('隔了一分钟的再次开口', 111)).resolves.toBeTruthy();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('⑤ 键真的被写下来了（否则第二次永远放行，闸是死的）', async () => {
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'b5', maxTextSends: 3 });
    // 用和前几条不同的文本——同一个 '第一句' 会先撞上 self-echo 闸（那也是好事，
    // 但会盖住这里要验的 burst 键）。echo 闸按 chatId 记最近发送，
    // 而 store/beforeEach 每次清空，所以换文本就够。
    await expect(host.telegram.sendText('burst 键写入验证专用文本', 111)).resolves.toBeTruthy();
    // set 是 fire-and-forget（.then 链），给一拍事件循环
    await new Promise((r) => setTimeout(r, 5));
    expect(store.has('xxb:agent:lastsend:b5')).toBe(true);
  });

  it('⑥ redis 读失败时 fail-open（防变胖的闸不能挡住发送）', async () => {
    store.set('xxb:agent:lastsend:b6', String(Math.floor(Date.now() / 1000)));
    const redis = await import('../../../src/db/redis.js');
    const spy = vi.spyOn(redis, 'getRedis').mockImplementationOnce(
      () => ({ get: async () => { throw new Error('redis down'); }, set: async () => 'OK' }) as never,
    );
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'b6', maxTextSends: 3 });
    await expect(host.telegram.sendText('redis 挂了也要发', 111)).resolves.toBeTruthy();
    spy.mockRestore();
  });

  it('⑧ 多片发完之后，紧接着再开口仍要拦（修分片不能把闸关死）', async () => {
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'b8', maxTextSends: 3 });
    await expect(host.telegram.sendText('第一句说完了。第二句也说完了。', 111)).resolves.toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    // 同一任务、同一秒再开口 → 必须拦
    await expect(host.telegram.sendText('补一句别的', 111)).rejects.toThrow(/未发送|秒前才在这个群说过话/);
  });

  it('⑦ 一条多片的话：所有片都要发得出去（k3 round 173 报的 P0）', async () => {
    // P0 复现：burst 键原来写在 parts 循环体内，于是第 2 片读到第 1 片
    // 1 秒前写的键 → gap≈1s < 12 → 自己吞掉自己的后半句。
    // 这正是 round 71 花大力气消灭的"半句话"，且形态是闸吃自己。
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'b7', maxTextSends: 3 });
    const text = '第一句说完了。第二句也说完了。第三句照样说得完。';
    await expect(host.telegram.sendText(text, 111)).resolves.toBeTruthy();
    const n = sendMessage.mock.calls.length;
    expect(n, '多片调用的每一片都该发出去（现在只剩 ' + n + ' 片）').toBeGreaterThan(1);
  });
});

