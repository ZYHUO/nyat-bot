/**
 * 身体信号注册表。
 *
 * 核心断言是扩展性本身：**新增一个信号不需要改 frame.ts**。
 * 这个测试注册一个一次性信号，证明它自动出现在 collectBodyFacts 的产出里，
 * 且单个信号挂掉不影响其它信号。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));

const m = await import('../../../src/nyatos/body-signal.js');

beforeEach(() => { m._resetBodySignals(); });

const CHAT = -1009999001;

describe('身体信号注册表', () => {
  it('注册即生效：新信号自动出现在产出里，无需改调用方', async () => {
    m.registerBodySignal({
      id: 'trench-like',
      order: 10,
      enabled: () => true,
      read: async () => ({ p: 3 }),
      render: (v) => `[身体] 气压 ${(v as { p: number }).p}`,
    });
    const facts = await m.collectBodyFacts(CHAT);
    expect(facts).toEqual(['[身体] 气压 3']);
  });

  it('未启用的信号不读不渲染', async () => {
    const read = vi.fn(async () => ({}));
    m.registerBodySignal({ id: 'off', enabled: () => false, read, render: () => 'X' });
    expect(await m.collectBodyFacts(CHAT)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('单个信号抛错只跳过它自己', async () => {
    m.registerBodySignal({
      id: 'boom', order: 5,
      enabled: () => true,
      read: async () => { throw new Error('redis down'); },
      render: () => 'never',
    });
    m.registerBodySignal({
      id: 'ok', order: 10,
      enabled: () => true,
      read: async () => 1,
      render: (v) => `好 ${v as number}`,
    });
    const facts = await m.collectBodyFacts(CHAT);
    expect(facts).toEqual(['好 1']);
  });

  it('render 返回空串 = 本次无话可说', async () => {
    m.registerBodySignal({
      id: 'quiet', enabled: () => true, read: async () => null, render: () => '',
    });
    expect(await m.collectBodyFacts(CHAT)).toEqual([]);
  });

  it('按 order 排序', async () => {
    m.registerBodySignal({ id: 'c', order: 30, enabled: () => true, read: async () => 0, render: () => 'C' });
    m.registerBodySignal({ id: 'a', order: 10, enabled: () => true, read: async () => 0, render: () => 'A' });
    m.registerBodySignal({ id: 'b', order: 20, enabled: () => true, read: async () => 0, render: () => 'B' });
    expect(await m.collectBodyFacts(CHAT)).toEqual(['A', 'B', 'C']);
  });

  it('重复 id 后者被忽略（热重载幂等）', async () => {
    m.registerBodySignal({ id: 'dup', enabled: () => true, read: async () => 1, render: () => '第一' });
    m.registerBodySignal({ id: 'dup', enabled: () => true, read: async () => 2, render: () => '第二' });
    expect(await m.collectBodyFacts(CHAT)).toEqual(['第一']);
    expect(m.listBodySignals()).toHaveLength(1);
  });

  it('ctx.senders 透传给需要"针对谁"的信号', async () => {
    const seen: number[] = [];
    m.registerBodySignal({
      id: 'per-sender',
      enabled: () => true,
      read: async (_c, ctx) => { for (const s of ctx?.senders ?? []) seen.push(s.uid); return 0; },
      render: () => '',
    });
    await m.collectBodyFacts(CHAT, { senders: [{ uid: 111 }, { uid: 222 }] });
    expect(seen).toEqual([111, 222]);
  });
});
