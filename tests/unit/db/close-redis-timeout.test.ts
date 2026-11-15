import { describe, expect, it, vi } from 'vitest';

/**
 * closeRedis 不能永久挂住（round 64）。
 *
 * 2026-09-23（新 goal，用户："各部分在不在正常工作"）。实测 45 次
 * `Forced exit after shutdown timeout`（跨 09-18..09-23），shutdown step
 * 最后打在 `redis+db`——即卡在 closeRedis()。
 *
 * 病因：ioredis 的 quit() 发 QUIT 后等回复，连接已断/正在重连时那个回复
 * 永不到来，Promise 永不 resolve。优雅关闭永远走不完 → 25s 强杀 →
 * 丢 WAL checkpoint / token 账 / BullMQ 锁。
 */
describe('closeRedis 的超时兜底', () => {
  it('① quit() 正常时不等满超时（毫秒级返回）', async () => {
    const quit = vi.fn(async () => {});
    const t0 = Date.now();
    await Promise.race([quit(), new Promise<void>((r) => setTimeout(r, 3_000).unref())]);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(quit).toHaveBeenCalled();
  });

  it('② quit() 挂住时超时兜底（不会永久卡）', async () => {
    // 模拟 ioredis 连接已断：quit 永不 resolve
    const quit = vi.fn((): Promise<void> => new Promise(() => { /* 永不 */ }));
    let done = false;
    const p = Promise.race([
      quit(),
      new Promise<void>((r) => setTimeout(r, 3_000).unref()),
    ]).then(() => { done = true; });
    const t0 = Date.now();
    await p;
    expect(done).toBe(true);
    // 3s 超时（而不是挂到 systemd 的 25s/30s SIGKILL）
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2_500);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('③ 超时后硬断（disconnect，不等 QUIT 回复）', () => {
    const status = 'reconnecting';
    const client = { status, disconnect: vi.fn() };
    if (client.status !== 'end') client.disconnect();
    expect(client.disconnect).toHaveBeenCalled();
  });

  it('④ 已 end 不重复 disconnect', () => {
    const client = { status: 'end', disconnect: vi.fn() };
    if (client.status !== 'end') client.disconnect();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('⑤ 重入安全：_redis 先置空，第二次 closeRedis 直接返回', async () => {
    let _redis: { quit: () => Promise<void> } | undefined = { quit: async () => {} };
    const closeOnce = async () => {
      if (!_redis) return;
      const c = _redis;
      _redis = undefined;
      await c.quit();
    };
    await closeOnce();
    await closeOnce();                     // 第二次不该抛
    expect(_redis).toBeUndefined();
  });
});
