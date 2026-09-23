import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 冷却必须按"解除条件的物理形状"分级，而不是一个正则全打成 5 分钟（round 182）。
 *
 * Round 83 为 403 concurrent limit 加了 5 分钟冷却，实测止住了 dshkimi 的
 * 403 死循环（570 次/天 → 可控）。但它那条正则
 * （`concurrent request limit|rate.?limit|too many requests`）把
 * **普通 RPM 限流也一并打成 5 分钟**——而 429 上面已经有 60s 短期冷却，
 * 这一行把它覆盖成 300s。
 *
 * 代价（round 148 量到）：09-20 起 All labels exhausted 从 138/天 涨到
 * 1600-2700/天；链越短（reflection 只有 1 个 label）越容易整批全灭
 * （round 147：deep-reflection 产出率 35%）。
 *
 * 分开的物理依据：
 *   · concurrent limit —— 等在飞请求跑完，与墙上时钟无关 → 长冷却
 *   · RPM / too many requests —— 滚动窗口，等一等就好 → 短冷却
 */
describe('限流冷却分级', () => {
  const SRC = 'src/ai/fallback.ts';

  const cooldownBlock = (): string => {
    const s = fs.readFileSync(SRC, 'utf8');
    const lines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    // 取**最后一次**出现——第一次是常量声明处的注释，不是使用点
    // （round 176 探针探错位置的同款错误）。
    let i = -1;
    for (let k = 0; k < lines.length; k++) {
      if (lines[k]!.includes('RATE_LIMIT_COOLDOWN_SEC')) i = k;
    }
    expect(i, '冷却那段不在').toBeGreaterThan(-1);
    return lines.slice(Math.max(0, i - 8), i + 6).join('\n');
  };

  it('① 长冷却只认 concurrent limit 形状', () => {
    const b = cooldownBlock();
    expect(b).toContain('concurrent request limit|in-flight|concurrent requests');
    // 旧的宽正则不能再出现在 setCooldown 的判定里
    const s = fs.readFileSync(SRC, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.some((l) => l.includes('RATE_LIMIT_COOLDOWN_SEC') && /rate\?\.limit/.test(l))).toBe(false);
  });

  it('② 普通限流走短期冷却（不覆盖成 300s）', () => {
    const b = cooldownBlock();
    expect(b).toContain("else if (err instanceof AIError && err.code === 'AI_RATE_LIMIT')");
  });

  it('③ 短期冷却那条也记数（否则分不开"降下来了"和"没下降"）', () => {
    const b = cooldownBlock();
    expect(b).toContain('llm_short_cooldown_total');
  });

  it('④ 注释说明为什么不敢反过来改（round 83 的实测依据）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('round 182');
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, i + 900);
    expect(block).toContain('round 83');
    expect(block).toContain('403');
    expect(block).toContain('round 148');
  });
});
