import { describe, expect, it, vi, beforeEach } from 'vitest';

// 时限旁路：TTL 到期自动恢复，实验因此不依赖"我之后一定回来撤"。
// 这个文件自带完整 redis mock（get/set/del）——heart-route 的 timed bypass 用动态
// import 取 getRedis，而该文件既有的 mock 没有 set/del。

const store = new Map<string, { v: string; ttl: number }>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k)?.v ?? null),
  set: vi.fn(async (k: string, v: string, _m?: string, ex?: number) => { store.set(k, { v, ttl: ex ?? 0 }); return 'OK'; }),
  del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const m = await import('../../../src/meta/heart-route.js');
beforeEach(() => { store.clear(); redisMock.get.mockClear(); redisMock.set.mockClear(); redisMock.del.mockClear(); });

describe('timed bypass', () => {
  it('grant 之后 has 为真，revoke 之后为假', async () => {
    await m.grantTimedBypass(-5001, 30);
    expect(await m.hasTimedBypass(-5001)).toBe(true);
    await m.revokeTimedBypass(-5001);
    expect(await m.hasTimedBypass(-5001)).toBe(false);
  });

  it('只对开过的群生效（不串群）', async () => {
    await m.grantTimedBypass(-5002, 30);
    expect(await m.hasTimedBypass(-5003)).toBe(false);
    await m.revokeTimedBypass(-5002);
  });

  it('grant 时带了 TTL（Redis 侧会自己过期）', async () => {
    await m.grantTimedBypass(-5004, 45);
    const k = [...store.keys()][0]!;
    expect(store.get(k)!.ttl).toBe(45 * 60);
  });

  it('时长有下限：不让人误设成 0 秒（等于瞬间恢复）', async () => {
    await m.grantTimedBypass(-5005, 0);
    const k = [...store.keys()][0]!;
    expect(store.get(k)!.ttl).toBe(60);
  });

  it('读失败按未开启处理——宁可不开，不要误开', async () => {
    await m.grantTimedBypass(-5006, 30);
    redisMock.get.mockRejectedValueOnce(new Error('redis down'));
    expect(await m.hasTimedBypass(-5006)).toBe(false);
  });
});
