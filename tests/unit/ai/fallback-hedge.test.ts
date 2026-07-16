import { describe, it, expect, vi, beforeEach } from 'vitest';

// codex #1 回归:hedge 分支必须对两跳都施加 rejectEmpty —— 否则 hedge 返回空内容
// 会被 Promise.any 当成功返回,heart/gate 解析失败 → fail-open → 吞回复。
// 开启 HEDGE_DELAY_MS(>0)让 hedge 路径生效,mock 到 callModel 层跑真实 callWithFallback。

const { callModelMock } = vi.hoisted(() => ({ callModelMock: vi.fn() }));

vi.mock('../../../src/ai/provider.js', () => ({ callModel: callModelMock }));
vi.mock('../../../src/ai/labels.js', () => ({
  getUsage: vi.fn(() => ({ label: 'primary', backups: ['hedge', 'last'], timeout: 30000 })),
  getLabel: vi.fn((name: string) => ({ name, endpoint: 'http://test', apiKeys: ['k'], model: `${name}-model` })),
}));
vi.mock('../../../src/ai/cooldown.js', () => ({
  CooldownTracker: class {
    isCoolingDown = async (): Promise<boolean> => false;
    setCooldown = async (): Promise<void> => {};
  },
}));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ HEDGE_DELAY_MS: 5 }) }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/ai/events.js', () => ({ emitLlmResult: vi.fn(), emitLlmError: vi.fn() }));

import { callWithFallback } from '../../../src/ai/fallback.js';

const res = (content: string) => ({ content, model: 'm', latencyMs: 1, usage: { promptTokens: 1, completionTokens: 1 } });
const opts = { usage: 'heart', messages: [{ role: 'user' as const, content: 'hi' }], rejectEmpty: true };
// 按 label 名返回不同内容;对泄漏的定时器(label undefined)返回非空、不崩(测试卫生)。
const byLabel = (map: Record<string, string>) =>
  callModelMock.mockImplementation((label?: { name: string }) =>
    Promise.resolve(res(label ? (map[label.name] ?? '[' + label.name + ']') : '[leak]')));

beforeEach(() => callModelMock.mockReset());

describe('callWithFallback hedge + rejectEmpty (codex #1)', () => {
  it('primary 空内容(hedge 开)→ 回退到 hedge 的非空结果,不返回空', async () => {
    byLabel({ primary: '', hedge: 'hedge-real', last: 'last-real' });
    const r = await callWithFallback(opts);
    expect(r.content.trim()).not.toBe('');
    expect(r.content).toBe('hedge-real');
  });

  it('primary 与 hedge 都空 → 继续落到第三个 backup(last)', async () => {
    byLabel({ primary: '', hedge: '', last: 'last-ok' });
    const r = await callWithFallback(opts);
    expect(r.content).toBe('last-ok');
  });

  it('全空 → 抛错(不静默返回空)', async () => {
    byLabel({ primary: '', hedge: '', last: '' });
    await expect(callWithFallback(opts)).rejects.toThrow();
  });
});
