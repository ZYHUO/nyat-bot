import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';

/**
 * round 248: **和 kimi 讨论后落地的裁决 + 数据。**
 *
 * 用户说"取舍和 kimi k3 讨论一下 我不接管"，所以问完我自己定。
 *
 * kimi 的判断（第一轮 + 补充三个事实后的第二轮）：
 *   1. 选 C，但 C 不等于躺平——缺的不是量具，是**失败实例**
 *   2. 若选 A：N 由要检测的变化量决定。~156 条/3 天 → ±5pp 需 n≈140，
 *      N<100 的 A 是"带光环的噪声"
 *   3. B 漏了更重要的：**trigger 消息 id + 原文快照**，不是 isBot。
 *      并且 round 211 的前提可推翻——广播 bot 的 uid 恒定，探针侧黑名单就够
 *   4. 第四条路：事故计数 + 一次性解剖（和 1/2/3 号同构）
 *   5. **76.3% 很可能就是健康值，而且指标方向可能整个是反的**——
 *      对 <20 字的回复，高 bigram 重合更像学舌，而"前言不搭后语"的典型死法
 *      恰恰是随机复读前文词。所以 0 重合中性甚至好，高重合才该报警。
 *
 * round 248 跑了 kimi 提的两个免费对照实验，结果**部分推翻他的预测**：
 *   - 他预测人基线 65-80% 与 bot 无可分辨差异 → 实测人 54.7%，差 22.8pp
 *   - 他预测洗牌后无差 → 量具归零 → 实测差 14pp，**真实窗口确实含信息**
 *   但他的核心判断被数据支持了：bot 的高重合几乎不存在（1%），
 *   而人有 13% 的消息 6+ 重合——所以"方向未定"这件事成立。
 */

const PROBE = 'scripts/coherence-probe.mts';

const runProbe = (days: number): string => {
  try {
    return execSync(`npx tsx ${PROBE} ${days}`, { encoding: 'utf8', timeout: 300_000, stdio: 'pipe' });
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? '');
  }
};

describe('round 248 裁决：量具降级为漂移检测器，绝对值不报告', () => {
  it('探针仍在、仍能跑（降级不是删掉）', () => {
    const out = runProbe(3);
    expect(out).toContain('bot 回复');
  });

  it('探针输出带单边判据的告诫（不许当绝对结论读）', () => {
    const out = runProbe(3);
    expect(out).toContain('单边判据');
  });

  it('known-issues 记了 kimi 的裁决和实验数据', () => {
    const ki = fs.readFileSync('docs/known-issues.md', 'utf8');
    expect(ki).toContain('kimi');
    expect(ki).toContain('漂移检测器');
    expect(ki).toContain('54.7');
  });
});
