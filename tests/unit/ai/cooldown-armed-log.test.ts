import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 「并发限流冷却已上架」必须可读（round 197）。
 *
 * 实测：同 model 相邻两次被 concurrent limit 打到的间隔，**87% 落在 300s 冷却期内**，
 * 甚至有 0-1 秒的（同 model 相邻对 1273 个，1111 个 ≤300s）。
 *
 * 也就是说 `setCooldown(model, 300)` 写了、`isCoolingDown(model)` 也读了，
 * 同一个 model 在冷却期内仍然被反复尝试。假说是 check-then-launch 非原子
 * （并发调用同刻读到"没在冷却"然后一起发车），但那之前没有任何日志能验证。
 */
describe('并发限流冷却上架可读', () => {
  const SRC = 'src/ai/fallback.ts';

  it('① 冷却上架那一下是 logger.info', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    // 找包含打点文字的**行**，再往上找这一句的 logger.xxx（它跨了两行）
    const i = code.findIndex((l) => l.includes('llm: concurrent-limit cooldown armed'));
    expect(i, '打点行不在').toBeGreaterThan(-1);
    const stmt = code.slice(Math.max(0, i - 1), i + 1).join(' ');
    expect(stmt).toContain('logger.info');
    expect(stmt).not.toContain('logger.debug');
  });

  it('② 带上 model 和冷却秒数（不然看不出"给谁上了多久"）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('cooldownSec: RATE_LIMIT_COOLDOWN_SEC');
    expect(s).toContain('model: label.model');
  });

  it('③ 注释写清那条 87% 的实测，否则下一个人嫌吵删掉', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('round 197');
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, i + 600);
    expect(block).toContain('87%');
    expect(block).toContain('check-then-launch');
  });

  it('④ 与结构性冷却分级并存（round 182 的分级没被这次改动破坏）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('concurrent request limit|in-flight|concurrent requests');
    expect(s).toContain('llm_short_cooldown_total');
  });
});
