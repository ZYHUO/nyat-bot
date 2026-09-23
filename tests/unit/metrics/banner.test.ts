import { describe, expect, it } from 'vitest';

/**
 * round 73: /metrics must carry its caliber header.
 *
 * Round 72 “输入不分级决策就会错”的应用：
 * 逗号分隔的计数器列表没有任何"这个 0 可不可疑"的信息。
 *
 * round 64 给 session-report 加了机会成本，而兜看 /metrics 看不到——
 * 同一份数据，两个入口，一个有口径一个没有。
 *
 * 三句必须在：重启归零 / 睡期 0 不是坏 / 越重启越励看 session-report。
 */

const { renderMetrics, renderMetricsWithBanner, incrCounter } = await import('../../../src/metrics/registry.js');

describe('/metrics 带口径头', () => {
  it('① 三句口径都在（重启归零 / 睡期 0 不是坏 / 趋势看 session-report）', () => {
    incrCounter('probe_banner', { p: '1' });
    const out = renderMetricsWithBanner();
    expect(out).toContain('重启归零');
    expect(out).toContain('触发条件不成立');
    expect(out).toContain('session-report.mts');
  });

  it('② 口径头不破坏 Prometheus 格式（# TYPE 行和样本还在）', () => {
    incrCounter('probe_banner', { p: '2' });
    const out = renderMetricsWithBanner();
    expect(out).toContain('# TYPE probe_banner counter');
    expect(out).toMatch(/probe_banner\{p="2"\} 1/);
  });

  it('③ banner 是注释行（# 开头）——Prometheus 解析器会忽略，不会污染数据', () => {
    const out = renderMetricsWithBanner();
    const header = out.split('\n').filter((l) => l.includes('重启归零') || l.includes('触发条件不成立'));
    expect(header.length).toBeGreaterThan(0);
    for (const l of header) expect(l.trimStart().startsWith('#')).toBe(true);
  });

  it('④ 裸 renderMetrics 不带 banner（给机器读的那个保持干净）', () => {
    const before = renderMetrics();
    expect(before).not.toContain('重启归零');
  });
});
