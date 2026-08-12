import { describe, it, expect, vi, beforeEach } from 'vitest';

// P2 多模态:带图调用必须跳过声明 VISION=false 的纯文本 label —— 纯文本模型
// 收到 image_url 必 400,白烧一跳还白刷熔断计数。未声明(undefined)的 label 照发。

const { callModelMock } = vi.hoisted(() => ({ callModelMock: vi.fn() }));

vi.mock('../../../src/ai/provider.js', () => ({ callModel: callModelMock }));
vi.mock('../../../src/ai/labels.js', () => ({
  getUsage: vi.fn(() => ({ label: 'textonly', backups: ['visionok'], timeout: 30000 })),
  getLabel: vi.fn((name: string) => ({
    name,
    endpoint: 'http://test',
    apiKeys: ['k'],
    model: `${name}-model`,
    capabilities: name === 'textonly' ? { vision: false } : { vision: true },
  })),
}));
vi.mock('../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    isCoolingDown = async (): Promise<boolean> => false;
    setCooldown = async (): Promise<void> => {};
    recordSuccess = async (): Promise<void> => {};
    recordFailure = async (): Promise<boolean> => false;
  },
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ HEDGE_DELAY_MS: 0 }) }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/ai/events.js', () => ({ emitLlmResult: vi.fn(), emitLlmError: vi.fn() }));

import { callWithFallback } from '../../../src/ai/fallback.js';

const res = (content: string) => ({ content, model: 'm', latencyMs: 1, usage: { promptTokens: 1, completionTokens: 1 } });

const imgMsgs = [
  {
    role: 'user' as const,
    content: [
      { type: 'image' as const, image: 'data:image/jpeg;base64,xx' },
      { type: 'text' as const, text: '图里写了啥' },
    ],
  },
];

beforeEach(() => callModelMock.mockReset());

describe('callWithFallback vision capability filter (P2)', () => {
  it('带图调用 → 跳过 VISION=false 的 label,直接打视觉 label', async () => {
    callModelMock.mockResolvedValue(res('看到了'));
    const r = await callWithFallback({ usage: 'reply', messages: imgMsgs });
    expect(r.content).toBe('看到了');
    expect(callModelMock).toHaveBeenCalledTimes(1);
    expect(callModelMock.mock.calls[0]![0].name).toBe('visionok'); // textonly 被跳过
  });

  it('纯文本调用 → 不过滤,primary 正常先打', async () => {
    callModelMock.mockResolvedValue(res('ok'));
    const r = await callWithFallback({ usage: 'reply', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.content).toBe('ok');
    expect(callModelMock.mock.calls[0]![0].name).toBe('textonly');
  });
});
