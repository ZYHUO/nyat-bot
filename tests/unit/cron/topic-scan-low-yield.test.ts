/**
 * topic-scan 的低抽取告警。
 *
 * 2026-09-21 加。实测：102 次 tick、扫了 2040 个群，只抽出 91 个标签（4.5%），
 * 而 `observed` 这个字段**一直都在日志里**，只是没人看。于是一次每 4 分钟烧 20 次
 * LLM 调用的 cron 长期以 4.5% 的效率空转，没有任何告警。
 *
 * 病因是 `maxTokens: 24`：topic-scan 只要 4-12 个汉字的标签，听上去 24 够用，
 * 但 judge usage 落到 step-3.7-flash 这种 reasoning 模型，思维链先烧 token，
 * content 恒为空 → extractTopic 返回 null → observed=0。
 *
 * 这里锁三件事：
 *   ① 连续低产才告警——单次 0 是正常的（群真的没话题时模型会正确返回 NONE）
 *   ② 高产一次就复位——不能一次成功洗掉之前的连续低产记录之外的状态
 *   ③ 阈值与 LLM 无关：这条告警不调用任何模型，纯粹数 observed/chats
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRecent: vi.fn(),
  discover: vi.fn(),
  observeTopic: vi.fn(),
  tickLifecycle: vi.fn(),
  getActiveTopics: vi.fn(),
  pruneDeadTopics: vi.fn(),
  callWithFallback: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  env: vi.fn(),
}));

vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: mocks.getRecent }));
vi.mock('../../../src/cron/active-hours.js', () => ({ discoverActiveGroupChats: mocks.discover }));
vi.mock('../../../src/tracking/topic-registry.js', () => ({
  observeTopic: mocks.observeTopic,
  tickLifecycle: mocks.tickLifecycle,
  getActiveTopics: mocks.getActiveTopics,
  pruneDeadTopics: mocks.pruneDeadTopics,
}));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: mocks.callWithFallback }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: mocks.logger }));
vi.mock('../../../src/env.js', () => ({ env: mocks.env }));

const { runTopicScan } = await import('../../../src/cron/topic-scan.js');

/**
 * 让 extractTopic 对前 okCount 个群返回标签，其余返回空（模拟 LLM 空转）。
 *
 * 注意：计数器按**每次 stubExtract 调用**归零，不跨 tick 累计。第一版写成闭包里
 * 一直递增，于是第二次 runTopicScan 时 n 已经从 20 起跑，全部返回空——
 * 测试测的是"stub 坏了"，不是"阈值判错了"。
 */
function stubExtract(okCount: number, total: number): void {
  let n = 0;
  mocks.callWithFallback.mockImplementation(async () => {
    n++;
    if (n <= okCount) return { content: `话题${n}`, tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 };
    return { content: '', tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 };
  });
  mocks.discover.mockResolvedValue(Array.from({ length: total }, (_, i) => -(100 + i)));
}

/** 跑 rounds 次 tick，每次都用同一套 okCount/total 的桩。 */
async function runRounds(rounds: number, okCount: number, total: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    stubExtract(okCount, total);
    await runTopicScan();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.mockReturnValue({ TOPIC_REGISTRY_ENABLED: true, TOPIC_SCAN_INTERVAL_MIN: 4 });
  // extractTopic 要求至少 3 条人类消息（MIN_HUMAN_MSGS）才肯花那次 LLM 调用。
  // 第一版只给 1 条，于是每次都在 LLM 之前返回 null——测试是绿的，
  // 但它验证的不是"低抽取告警"，而是"消息不够所以跳过"。这类假绿最坑。
  mocks.getRecent.mockResolvedValue([
    { role: 'user', uid: 1, messageId: 1, textContent: '在吗', timestamp: 0, isForwarded: false },
    { role: 'user', uid: 2, messageId: 2, textContent: '节点咋样', timestamp: 0, isForwarded: false },
    { role: 'user', uid: 3, messageId: 3, textContent: '速度还行', timestamp: 0, isForwarded: false },
  ]);
  mocks.getActiveTopics.mockReturnValue([]);
});

describe('topic-scan 低抽取告警', () => {
  it('① 关旗标 → 直接返回，不扫群', async () => {
    mocks.env.mockReturnValue({ TOPIC_REGISTRY_ENABLED: false });
    await runTopicScan();
    expect(mocks.discover).not.toHaveBeenCalled();
  });

  it('② 连续 5 次低产才告警（单次 0 不报——群冷清是正常）', async () => {
    await runRounds(4, 0, 20);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    stubExtract(0, 20);
    await runTopicScan(); // 第 5 次
    expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    const arg = mocks.logger.warn.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg['chats']).toBe(20);
    expect(arg['observed']).toBe(0);
    expect(arg['consecutive']).toBe(5);
  });

  it('③ 一次高产就复位（冷清几轮后又热闹起来，不该留着旧账）', async () => {
    await runRounds(4, 0, 20);
    await runRounds(1, 15, 20);       // 高产一次 → 复位
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    await runRounds(4, 0, 20);        // 复位后再来 4 次低产仍不该告警
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('④ 阈值是 15%：恰好在线上的算高产', async () => {
    await runRounds(8, 3, 20);        // 3/20 = 0.15，恰好在线，不算低
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('⑤ 低产仍照常推进生命周期（告警不改变行为）', async () => {
    await runRounds(6, 0, 4);
    expect(mocks.tickLifecycle).toHaveBeenCalledTimes(24); // 6 × 4 个群
    expect(mocks.pruneDeadTopics).toHaveBeenCalledTimes(6);
    expect(mocks.observeTopic).not.toHaveBeenCalled();
  });

  it('⑥ 空群列表 → 不除零、不告警', async () => {
    mocks.discover.mockResolvedValue([]);
    for (let i = 0; i < 8; i++) await runTopicScan();
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('⑦ 每次 tick 都记 info（observed 这个字段必须在，这次事故就是因为它没人看）', async () => {
    stubExtract(2, 20);
    await runTopicScan();
    const call = mocks.logger.info.mock.calls.find((c) => c[1] === 'Topic scan tick');
    expect(call).toBeDefined();
    expect((call![0] as Record<string, unknown>)['observed']).toBe(2);
  });
});
