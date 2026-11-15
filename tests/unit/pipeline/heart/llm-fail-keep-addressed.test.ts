/**
 * 心流 LLM 失败时的**保句闸**（2026-09-21 新增的前置功能）。
 *
 * 实测依据：`heart LLM failed, fail-closed pass` 在日志里 1867 次，占全部心流
 * 裁决（7443 次）的 25%；失败原因 64% 是 "All labels exhausted"（整条
 * fallback 链死透），其余是超时/限流/内容审查。
 *
 * 旧行为一律 `pass` = **消息被永久丢弃**。对没人叫 bot 的群聊消息没毛病，
 * 但对直接叫到 bot 的那句是另一回事：有人 @ 了本喵问一件事，因为线路故障，
 * 这句话就此消失，对方永远等不到回复。这和"无视直接提问是另一种失败"
 * 是同一条原则——只是失败方从模型变成了线路。
 *
 * 这里锁四件事：
 *   ① 被直接叫到（回复 bot）→ wait，不 pass
 *   ② 没被叫到 → 仍旧 pass（避免线路故障时把整群闲聊都排成重试）
 *   ③ 开关关 → 完全回到旧行为
 *   ④ 寻址判定本身（@username / 昵称 / 回复 bot）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callModelMock } = vi.hoisted(() => ({ callModelMock: vi.fn() }));
const QQ_CHAT = -(2 ** 52 + 10);
const QQ_SELF = 2 ** 52 + 11;

vi.mock('../../../../src/ai/provider.js', () => ({ callModel: callModelMock }));
vi.mock('../../../../src/ai/labels.js', () => ({
  getUsage: vi.fn(() => ({ label: 'primary', backups: ['lite'], timeout: 30000 })),
  getLabel: vi.fn((name: string) => ({
    name, endpoint: 'http://test', apiKeys: ['k'], model: `${name}-model`,
  })),
}));
vi.mock('../../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    isCoolingDown = async (): Promise<boolean> => false;
    setCooldown = async (): Promise<void> => {};
    recordSuccess = async (): Promise<void> => {};
    recordFailure = async (): Promise<boolean> => false;
  },
}));
vi.mock('../../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));

const envValues: Record<string, unknown> = {
  TIMING_GATE_USAGE: 'judge',
  TIMING_GATE_TIMEOUT_MS: 8000,
  HEDGE_DELAY_MS: 0,
  HEART_LLM_FAIL_KEEP_ADDRESSED: true,
};
vi.mock('../../../../src/env.js', () => ({ env: () => envValues }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/pipeline/context/slim.js', () => ({ slimContextForAi: undefined, slimContextForAI: vi.fn(() => 'CTX') }));
vi.mock('../../../../src/shared/config.js', () => ({
  loadCachedPrompt: vi.fn(() => 'x {bot_name} {persona_core} {self_state}'),
}));
// bot 身份：寻址判定要用 username + nicknames
vi.mock('../../../../src/bot/bot.js', () => ({
  getBotIdentity: (chatId?: number) => chatId === QQ_CHAT
    ? { uid: QQ_SELF, username: '', displayName: 'QQ喵', nicknames: ['QQ喵'] }
    : { uid: 9, username: 'hunhebi_bot', displayName: '啾咪囝', nicknames: ['啾咪囝', '本喵'] },
  getBotUid: () => 9,
}));

const { heartDecision, isAddressedToBot } = await import('../../../../src/pipeline/heart/decision.js');
import type { FormattedMessage } from '../../../../src/shared/types.js';
import { loadCachedPrompt } from '../../../../src/shared/config.js';

const netError = (): Error => new TypeError('fetch failed');

const baseInput = (over: Record<string, unknown> = {}) => ({
  chatId: -1,
  message: {
    role: 'user', uid: 1, messageId: 9, fullName: 'A', username: 'a',
    textContent: 'hi', timestamp: 0, isForwarded: false,
  } as FormattedMessage,
  recentMessages: [],
  botUid: 9,
  botName: 'x',
  selfState: { narration: 'n', narrationNoThought: 'n', energy: 1 },
  ...over,
});

beforeEach(() => {
  callModelMock.mockReset();
  envValues.HEART_LLM_FAIL_KEEP_ADDRESSED = true;
  envValues.META_QQ_MENTION_HEART_ENABLED = false;
  vi.mocked(loadCachedPrompt).mockReturnValue('x {bot_name} {persona_core} {self_state}');
});

describe('isAddressedToBot', () => {
  const msg = (over: Record<string, unknown>): FormattedMessage =>
    ({ role: 'user', uid: 1, messageId: 9, textContent: '', timestamp: 0, isForwarded: false, ...over }) as FormattedMessage;

  it('回复 bot → 是', () => {
    expect(isAddressedToBot(msg({ replyTo: { uid: 9, messageId: 8 } }), 9)).toBe(true);
  });

  it('回复别人 → 不是', () => {
    expect(isAddressedToBot(msg({ replyTo: { uid: 77, messageId: 8 } }), 9)).toBe(false);
  });

  it('@username → 是', () => {
    expect(isAddressedToBot(msg({ textContent: '@hunhebi_bot 在吗' }), 9)).toBe(true);
  });

  it('叫昵称 → 是', () => {
    expect(isAddressedToBot(msg({ textContent: '本喵 帮个忙' }), 9)).toBe(true);
    expect(isAddressedToBot(msg({ textContent: '啾咪囝 早' }), 9)).toBe(true);
  });

  it('普通群聊 → 不是', () => {
    expect(isAddressedToBot(msg({ textContent: '明天去海边吗' }), 9)).toBe(false);
  });

  it('空消息 → 不是（不猜）', () => {
    expect(isAddressedToBot(msg({ textContent: '' }), 9)).toBe(false);
  });

  it('QQ identity recognizes its own internal mention and never any arbitrary @ or TG handle', () => {
    expect(isAddressedToBot(msg({ textContent: `@${QQ_SELF}在吗` }), QQ_SELF, QQ_CHAT)).toBe(true);
    expect(isAddressedToBot(msg({ textContent: `@${QQ_SELF + 1} 在吗` }), QQ_SELF, QQ_CHAT)).toBe(false);
    expect(isAddressedToBot(msg({ textContent: `@${QQ_SELF}1` }), QQ_SELF, QQ_CHAT)).toBe(false);
    expect(isAddressedToBot(msg({ textContent: '@hunhebi_bot 在吗' }), QQ_SELF, QQ_CHAT)).toBe(false);
    expect(isAddressedToBot(msg({ textContent: 'QQ喵 在吗' }), QQ_SELF, QQ_CHAT)).toBe(true);
    expect(isAddressedToBot(msg({ replyTo: { uid: 9, messageId: 8 } }), QQ_SELF, QQ_CHAT)).toBe(false);
  });
});

describe('心流 LLM 失败时的保句闸', () => {
  it.each([
    { chatId: QQ_CHAT, enabled: true, override: true },
    { chatId: QQ_CHAT, enabled: false, override: false },
    { chatId: -123, enabled: true, override: false },
  ])('scopes the system-level addressing override: $chatId / enabled=$enabled', async ({ chatId, enabled, override }) => {
    envValues.META_QQ_MENTION_HEART_ENABLED = enabled;
    vi.mocked(loadCachedPrompt).mockReturnValue('点名你的（@你/回复你/叫你名字）永远不许 pass。');
    callModelMock.mockResolvedValue({ content: '{"act":"pass","path":"chat","why":"自然听着"}', tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });
    await heartDecision(baseInput({ chatId }));
    const messages = callModelMock.mock.calls[0]![1] as Array<{ role: string; content: string }>;
    const system = messages.find(message => message.role === 'system')!.content;
    expect(system.includes('[当前QQ群回应规则')).toBe(override);
    if (override) {
      expect(system).toContain('以上规则替代前文与之冲突的点名禁令');
      expect(system).toContain('可以 react 或 pass');
      expect(system).toContain('真实提问、请求和需要确认的指令优先 reply');
    }
  });
  it('preserves authenticated addressing from an earlier QQ bubble when the final bubble has no name', async () => {
    envValues.HEART_LLM_FAIL_KEEP_ADDRESSED = false;
    callModelMock.mockRejectedValue(netError());
    const decision = await heartDecision(baseInput({ chatId: QQ_CHAT, botUid: QQ_SELF, addressed: true }));
    expect(decision.act).toBe('wait');
  });

  it.each(['prompt', 'invalid-json'] as const)('keeps addressed QQ input on %s failure', async failure => {
    if (failure === 'prompt') vi.mocked(loadCachedPrompt).mockImplementation(() => { throw new Error('fixture'); });
    callModelMock.mockResolvedValue({ content: 'invalid', tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });
    expect((await heartDecision(baseInput({ chatId: QQ_CHAT, botUid: QQ_SELF, addressed: true }))).act).toBe('wait');
  });

  it('states protocol addressing while permitting a non-text response', async () => {
    callModelMock.mockResolvedValue({ content: '{"act":"react","path":"chat","why":"打招呼","emoji":"👍"}', tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });
    expect((await heartDecision(baseInput({ chatId: QQ_CHAT, botUid: QQ_SELF, addressed: true }))).act).toBe('react');
    expect(JSON.stringify(callModelMock.mock.calls)).toContain('被提及不等于必须发一条文字');
    expect(JSON.stringify(callModelMock.mock.calls)).toContain('真实提问、请求');
  });
  it('keeps a QQ internal self mention on model failure, with the current chat identity', async () => {
    callModelMock.mockRejectedValue(netError());
    const d = await heartDecision(baseInput({ chatId: QQ_CHAT, botUid: QQ_SELF,
      message: { role: 'user', uid: QQ_SELF + 1, messageId: 9, textContent: `@${QQ_SELF} 帮忙`, timestamp: 0, isForwarded: false } as FormattedMessage }));
    expect(d.act).toBe('wait');
    expect(d.why).toBe('llm_failed_keep_addressed');
  });
  it('① 被直接叫到 + LLM 全挂 → wait（保句），不 pass（丢弃）', async () => {
    callModelMock.mockRejectedValue(netError());
    const d = await heartDecision(
      baseInput({ message: { role: 'user', uid: 1, messageId: 9, textContent: '@hunhebi_bot 这个多少钱', timestamp: 0, isForwarded: false } as FormattedMessage }),
    );
    expect(d.act).toBe('wait');
    expect(d.why).toBe('llm_failed_keep_addressed');
    // judgeResult 对 reply/wait 都折算成 REPLY（JudgeAction 没有 WAIT 这个值，
    // 这是既有行为）；调用方分支看的是 heart.act，不是 judgeResult.action。
    expect(d.judgeResult.action).toBe('REPLY');
  });

  it('② 没被叫到 + LLM 全挂 → 仍旧 pass（不把整群闲聊排成重试）', async () => {
    callModelMock.mockRejectedValue(netError());
    const d = await heartDecision(baseInput());
    expect(d.act).toBe('pass');
    expect(d.why).toBe('llm_failed');
  });

  it('②b 回复 bot 也算被叫到', async () => {
    callModelMock.mockRejectedValue(netError());
    const d = await heartDecision(
      baseInput({ message: { role: 'user', uid: 1, messageId: 9, textContent: '那这个呢', replyTo: { uid: 9, messageId: 8 }, timestamp: 0, isForwarded: false } as FormattedMessage }),
    );
    expect(d.act).toBe('wait');
    expect(d.why).toBe('llm_failed_keep_addressed');
  });

  it('③ 开关关 → 完全回到旧行为（一律 pass）', async () => {
    envValues.HEART_LLM_FAIL_KEEP_ADDRESSED = false;
    callModelMock.mockRejectedValue(netError());
    const d = await heartDecision(
      baseInput({ message: { role: 'user', uid: 1, messageId: 9, textContent: '@hunhebi_bot 在吗', timestamp: 0, isForwarded: false } as FormattedMessage }),
    );
    expect(d.act).toBe('pass');
    expect(d.why).toBe('llm_failed');
  });

  it('④ LLM 正常时不受影响（这条路只在失败时走）', async () => {
    callModelMock.mockResolvedValue({ content: '{"act":"reply","path":"chat","why":"ok"}', tokenUsage: { prompt: 1, completion: 1, total: 2 }, model: 'm', label: 'l', latencyMs: 1 });
    const d = await heartDecision(
      baseInput({ message: { role: 'user', uid: 1, messageId: 9, textContent: '@hunhebi_bot 在吗', timestamp: 0, isForwarded: false } as FormattedMessage }),
    );
    expect(d.act).toBe('reply');
    expect(d.why).toBe('ok');
  });

  it('④b 缺这个 flag（env mock 成缺键对象）→ 不崩，按旧行为 pass', async () => {
    delete envValues.HEART_LLM_FAIL_KEEP_ADDRESSED;
    callModelMock.mockRejectedValue(netError());
    const d = await heartDecision(
      baseInput({ message: { role: 'user', uid: 1, messageId: 9, textContent: '@hunhebi_bot 在吗', timestamp: 0, isForwarded: false } as FormattedMessage }),
    );
    expect(d.act).toBe('pass');
  });
});
