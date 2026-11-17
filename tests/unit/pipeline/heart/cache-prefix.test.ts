import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeartInput } from '../../../../src/pipeline/heart/decision.js';

const fixture = vi.hoisted(() => ({
  call: vi.fn(),
  prompt: vi.fn(),
  reflection: vi.fn<() => string | null>(),
  config: {
    OUTCOME_TRACKING_ENABLED: true,
    META_QQ_MENTION_HEART_ENABLED: false,
    HEART_REFLECT_ENABLED: false,
    TIMING_GATE_TIMEOUT_MS: 8000,
  },
}));

// Mock the direct modules: this test exercises prompt assembly, never runtime
// configuration, provider routing, chat history, telemetry or any database.
vi.mock('../../../../src/ai/fallback.js', () => ({ callWithFallback: fixture.call }));
vi.mock('../../../../src/shared/config.js', () => ({ loadCachedPrompt: fixture.prompt }));
vi.mock('../../../../src/env.js', () => ({ env: () => fixture.config }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../src/pipeline/context/slim.js', () => ({ slimContextForAI: () => '合成群聊上下文' }));
vi.mock('../../../../src/meta/answered.js', () => ({ answeredTimestamps: async () => [] }));
vi.mock('../../../../src/metrics/registry.js', () => ({ incrCounter: vi.fn() }));
vi.mock('../../../../src/metrics/social-ledger.js', () => ({ recordDecision: vi.fn() }));
vi.mock('../../../../src/tracking/outcome.js', () => ({ getReflection: fixture.reflection }));
vi.mock('../../../../src/pipeline/judge/rules.js', () => ({ isMentioningSelf: () => false }));
vi.mock('../../../../src/bot/bot.js', () => ({
  getBotIdentity: () => ({ uid: 9, username: 'test_bot', nicknames: [] }),
}));
vi.mock('../../../../src/platform/identity-store.js', () => ({
  isPlatformInternalId: (id: number) => Math.abs(id) >= 2 ** 52,
}));

import { heartDecision } from '../../../../src/pipeline/heart/decision.js';

const heartTemplate = readFileSync('prompts/task/heart.md', 'utf8');
const valid = '{"act":"pass","path":"chat","why":"听到了"}';

interface CapturedCall {
  usage: string;
  systemCachePrefix?: string;
  messages: Array<{ role: string; content: string }>;
}

function input(narration = '合成状态甲'): HeartInput {
  return {
    chatId: -1001,
    message: {
      role: 'user', uid: 1, messageId: 10, fullName: '测试用户',
      textContent: '合成消息', timestamp: 0, isForwarded: false,
    },
    recentMessages: [], botUid: 9, botName: '测试喵',
    selfState: { narration, narrationNoThought: narration, energy: 1 },
  };
}

function callAt(index: number): CapturedCall {
  return fixture.call.mock.calls[index]![0] as CapturedCall;
}

function systemOf(call: CapturedCall): string {
  return call.messages.find(message => message.role === 'system')!.content;
}

beforeEach(() => {
  fixture.call.mockReset().mockResolvedValue({ content: valid });
  fixture.reflection.mockReset().mockReturnValue(null);
  fixture.prompt.mockReset().mockImplementation((name: string) => {
    if (name === 'task/heart.md') return heartTemplate;
    if (name === 'identity/persona.md') return '固定的测试人格与身份规则';
    if (name === 'identity/behavior-style.md') return '固定的测试参与风格';
    throw new Error('Unexpected prompt requested');
  });
  fixture.config.OUTCOME_TRACKING_ENABLED = true;
  fixture.config.META_QQ_MENTION_HEART_ENABLED = false;
  fixture.config.HEART_REFLECT_ENABLED = false;
});

describe('Heart stable system cache prefix', () => {
  it('keeps the full fixed rules before changing state and learned rules', async () => {
    fixture.reflection.mockReturnValue('合成经验甲：接住完整问题');
    await heartDecision(input('合成状态甲：精力充足'));
    fixture.reflection.mockReturnValue('合成经验乙：听完连发再说');
    await heartDecision(input('合成状态乙：正在听群友说话'));

    const first = callAt(0);
    const second = callAt(1);
    expect(first.systemCachePrefix).toBeTruthy();
    expect(second.systemCachePrefix).toBe(first.systemCachePrefix);
    for (const call of [first, second]) {
      const system = systemOf(call);
      expect(system.startsWith(call.systemCachePrefix!)).toBe(true);
      for (const heading of ['## 第一步', '## 怎么决定', '### react', '### wait', '### 铁律', '## 输出']) {
        expect(call.systemCachePrefix).toContain(heading);
      }
      expect(system).not.toMatch(/\{(?:bot_name|persona_core|self_state|learned_rules)\}/);
      expect(call.systemCachePrefix).not.toContain('合成状态');
      expect(call.systemCachePrefix).not.toContain('合成经验');
      expect(call.systemCachePrefix).toContain('不覆盖身份、隐私、权限、JSON 输出契约或宿主明确的 QQ 回应规则');
      expect(call.systemCachePrefix).toContain('不授予新权限或跨会话披露授权');
      expect(system.indexOf('## 输出')).toBeLessThan(system.indexOf('## 此刻的你'));
    }
    expect(systemOf(first)).toContain('合成状态甲：精力充足');
    expect(systemOf(first)).toContain('合成经验甲：接住完整问题');
    expect(systemOf(first)).not.toContain('合成经验乙');
    expect(systemOf(second)).toContain('合成状态乙：正在听群友说话');
    expect(systemOf(second)).toContain('合成经验乙：听完连发再说');
    expect(systemOf(second)).not.toContain('合成经验甲');
  });

  it('passes the same exact prefix and full system to parse correction', async () => {
    fixture.call.mockReset()
      .mockResolvedValueOnce({ content: '不是 JSON' })
      .mockResolvedValueOnce({ content: valid });
    fixture.reflection.mockReturnValue('合成重试经验');

    const decision = await heartDecision(input());

    expect(decision.why).toBe('听到了');
    expect(fixture.call).toHaveBeenCalledTimes(2);
    const first = callAt(0);
    const retry = callAt(1);
    expect(first.systemCachePrefix).toBeTruthy();
    expect(retry.systemCachePrefix).toBe(first.systemCachePrefix);
    expect(systemOf(retry)).toBe(systemOf(first));
    expect(systemOf(retry).startsWith(retry.systemCachePrefix!)).toBe(true);
    expect(retry.messages[2]).toEqual({ role: 'assistant', content: '不是 JSON' });
    expect(retry.messages[3]!.content).toContain('只输出一个非空 JSON 对象');
  });

  it('preserves the final QQ policy override after the dynamic context', async () => {
    fixture.config.META_QQ_MENTION_HEART_ENABLED = true;
    const qq = input();
    qq.chatId = -(2 ** 52 + 10);
    await heartDecision(qq);

    const call = callAt(0);
    const system = systemOf(call);
    expect(system.startsWith(call.systemCachePrefix!)).toBe(true);
    expect(system).toContain('被 @、被引用或被叫名字表示对方在叫你本人');
    expect(system).toContain('其他安全、隐私与身份规则继续适用');
    expect(system.indexOf('[当前QQ群回应规则')).toBeGreaterThan(system.indexOf('合成状态甲'));
    expect(call.systemCachePrefix).not.toContain('[当前QQ群回应规则');
  });

  it('does not put an earlier learned-rule slot in a customized template into the prefix', async () => {
    fixture.prompt.mockImplementation((name: string) => name === 'task/heart.md'
      ? '固定开头\n{learned_rules}\n更多说明\n{self_state}' : '固定人格');
    fixture.reflection.mockReturnValue('合成自定义经验');
    await heartDecision(input());

    const call = callAt(0);
    expect(call.systemCachePrefix).toBe('固定开头\n');
    expect(systemOf(call).startsWith(call.systemCachePrefix!)).toBe(true);
    expect(systemOf(call)).toContain('合成自定义经验');
    expect(systemOf(call)).toContain('合成状态甲');
  });

  it('keeps the same prefix when learned feedback is disabled', async () => {
    await heartDecision(input());
    fixture.config.OUTCOME_TRACKING_ENABLED = false;
    fixture.reflection.mockClear().mockReturnValue('不应读取的合成经验');
    await heartDecision(input('另一种合成状态'));

    expect(fixture.reflection).not.toHaveBeenCalled();
    expect(callAt(1).systemCachePrefix).toBe(callAt(0).systemCachePrefix);
    expect(systemOf(callAt(1))).not.toContain('不应读取的合成经验');
  });

  it('does not reuse the decision prefix for the separate reflection prompt', async () => {
    fixture.config.HEART_REFLECT_ENABLED = true;
    fixture.call.mockReset()
      .mockResolvedValueOnce({ content: '{"act":"reply","path":"chat","why":"想接话"}' })
      .mockResolvedValueOnce({ content: '接住新问题' });

    const decision = await heartDecision(input());

    expect(fixture.call).toHaveBeenCalledTimes(2);
    expect(callAt(0).systemCachePrefix).toBeTruthy();
    expect(callAt(1).systemCachePrefix).toBeUndefined();
    expect(callAt(1).usage).toBe('summarize');
    expect(systemOf(callAt(1))).toContain('当前念头是「想接话」');
    expect(systemOf(callAt(1))).toContain('再想半秒');
    expect(callAt(1).messages[1]!.content).toContain('合成群聊上下文');
    expect(decision.why).toBe('接住新问题');
  });
});
