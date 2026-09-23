import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 账号级限流（403 concurrent limit）要冷却久一点（round 83）。
 *
 * 2026-09-23 实测 dshkimi 一天 570 次失败，其中 **491 次（86%）** 是
 * `HTTP 403: You've reached your concurrent request limit`，
 * 平均每 2.4 分钟一次。
 *
 * 而默认冷却 60s / 熔断 120s 不够——那种限流的解除取决于**在飞的请求跑完**，
 * 不是墙上时钟走到 120s。于是形成循环：
 *
 *   熔断 120s → 回链 → 立刻再被打 → 403 → 再熔断 → …
 *
 * 修：403 / concurrent limit / too many requests 用 5 分钟冷却。
 * 只影响这一个错误码，其余照旧。
 */
describe('账号级限流的冷却时长', () => {
  const SRC = 'src/ai/fallback.ts';

  it('① 有 RATE_LIMIT_COOLDOWN_SEC 常量，且 >= 240（比熔断久）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const m = s.match(/const RATE_LIMIT_COOLDOWN_SEC = (\d+);/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(240);
  });

  it('② 判据覆盖 403 的三种常见文案', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('concurrent request limit');
    expect(s).toContain('rate.?limit');
    expect(s).toContain('too many requests');
  });

  it('③ 用 setCooldown(model, RATE_LIMIT_COOLDOWN_SEC)（不是默认 TTL）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('cooldown.setCooldown(label.model, RATE_LIMIT_COOLDOWN_SEC)');
  });

  it('④ 429 那条不动（短期冷却仍是 60s）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('await cooldown.setCooldown(label.model);');
  });

  it('⑤ 判据只在 AIError 上跑（别把 TypeError 也当限流）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('RATE_LIMIT_COOLDOWN_SEC);');
    const before = s.slice(Math.max(0, i - 300), i);
    expect(before).toContain('err instanceof AIError');
  });
});
