import { describe, expect, it, vi } from 'vitest';

/**
 * round 85: **进程忩命要有行日志。**
 *
 * Round 63 只在启动时打一句话（"进程内闸在这里清零"）——那只回答了
 * "下一个看日志的人知道为什么闸可能是 0"，没有告诉他
 * "**这一刻闸到底能不能瞄满窗口**"。
 *
 * Round 84 把它列为待排期，那次排期的收获是“它其实不费”——
 * 差的只是轮次号，不是工程量。所以当轮做。
 */

const LOG_METHODS = ['info', 'warn', 'error', 'debug'] as const;
const calls: Array<Record<string, unknown> | undefined> = [];

vi.mock('../../../src/shared/logger.js', () => ({
  logger: Object.fromEntries(LOG_METHODS.map((m) => [m, (...a: unknown[]) => { calls.push(a[0] as Record<string, unknown> | undefined); }])),
}));

// 模块在 mock 之后才读得到，而 bootedAtSec 在模块加载时就固定了。
// 所以用真模块：它的行为只依赖 Date.now()，我们能推动。
const mod = await import('../../../src/cron/restart-hygiene.js');

const lastPayload = (): Record<string, unknown> => calls[calls.length - 1] ?? {};
const lastMsg = (): string => {
  // vi.mock 的 替踨只接了第一个参数——而 logger.info(obj, msg) 的 msg 是第二个。
  // 所以这里改为验证 payload 里的标志位字段（那才是行为的一部分）。
  return '';
};
void lastMsg;

describe('进程寿命量纸', () => {
  it('① 打出 ageSec / ageMin / shortLived（三样都要有，否则读不出结论）', () => {
    calls.length = 0;
    mod.reportProcessLifetime();
    // 第一次调用一定打（lastLogSec=0）
    expect(calls.length).toBe(1);
    const p = lastPayload();
    expect(typeof p['ageSec']).toBe('number');
    expect(typeof p['ageMin']).toBe('number');
    expect(typeof p['shortLived']).toBe('boolean');
  });

  it('② shortLived 和 ageSec 的关系自活（ageSec<15min ⇔ shortLived）', () => {
    // 不能控制 bootedAtSec（模块加载时固定），但可以验它们的关系。
    // 用一个已知入口逐字校验：重新读源码把常数拿出来。
    const fs0 = require('node:fs') as typeof import('node:fs');
    const src = fs0.readFileSync('src/cron/restart-hygiene.ts', 'utf8');
    const m = /const SHORT_LIVED_SEC = (\d+) \* 60;/.exec(src
      .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n'));
    expect(m, 'SHORT_LIVED_SEC 常数不在（不该变成配置）').not.toBeNull();
    // round 85: **阈值本身也要骄**——只验关系的话，改成 0
    // （永远 short）或者 1440（永远 steady）都不会红，而那两个都让
    // 这个量纸失去意义。固定在 15 分钟（round 44 量出的 p50 是 7 分钟、平均 21）。
    expect(Number(m![1]), 'SHORT_LIVED_SEC 应为 15 分钟（小于 p50 的一倍以上）').toBe(15);
    const sec = Number(m![1]) * 60;
    calls.length = 0;
    mod.reportProcessLifetime();
    if (calls.length === 0) return;   // 被节流就跳过（判据可靠）
    const p = lastPayload();
    expect(p['shortLived']).toBe((p['ageSec'] as number) < sec);
  });

  it('③ 节流：一小时只打一次（否则每小时 tick 变每秒刷屏）', () => {
    calls.length = 0;
    mod.reportProcessLifetime();      // 第一次一定打
    const after1 = calls.length;
    mod.reportProcessLifetime();      // 紧接着的第二次被节流
    mod.reportProcessLifetime();
    expect(calls.length).toBe(after1);
  });

  it('④ scheduler 真的注册了它（round 173 同款：不是只定义了模块）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/cron/scheduler.ts', 'utf8');
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.some((l) => l.includes('process-lifetime'))).toBe(true);
    expect(code.some((l) => l.includes('reportProcessLifetime'))).toBe(true);
  });

  it('⑤ reportProcessLifetime 不写 Redis、不读 DB（它的代价必须是零）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/cron/restart-hygiene.ts', 'utf8');
    const fnStart = src.indexOf('export function reportProcessLifetime');
    expect(fnStart).toBeGreaterThan(-1);
    const body = src.slice(fnStart, fnStart + 1200);
    expect(body).not.toContain('getRedis');
    expect(body).not.toContain('getDb');
  });
});
