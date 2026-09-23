import { describe, expect, it } from 'vitest';

/**
 * round 65：**本 session 新加的计数器必须真的在 incrCounter 的路径上**。
 *
 * Round 64 抓到"字段加了没初始化 → 恒 0"，那个坑的通性是
 * **代码在、数字永远是 0**。而这会话修过一整族同形的：
 *   round 191 debug 级不可见 / round 201 兜底恒真 / else-if 断链 / round 64 字段没初始化。
 *
 * 计数器类是其中最好验的：`incrCounter(name, labels)` 只是一个 Map.set，
 * **名字拼错、调用点没接上、或者根本没调用**，现象完全一样——metrics 里恒无。
 *
 * 这个测试不依赖流量：直接调 incrCounter 再 renderMetrics，看名字在不在。
 * 这比"等生产触发"强——生产里这些计数器的触发条件（群醒 + 特定形状）都很稀有。
 */

const { incrCounter, renderMetrics } = await import('../../../src/metrics/registry.js');
const { execSync } = await import('node:child_process');

/** 本 session（round 167-64）新加的计数器，按所在模块分组。 */
const NEW_COUNTERS: Array<{ name: string; where: string }> = [
  { name: 'command_router_skip_unaddressed_total', where: 'round 167 命令路由寻址前置' },
  { name: 'delegation_missing_args_total', where: 'round 169 arity 缺参闸' },
  { name: 'delegation_receipt_usage_error_total', where: 'round 168 退回判读' },
  { name: 'send_task_burst_total', where: 'round 171 task 级 burst 闸' },
  { name: 'send_topic_word_repeat_total', where: 'round 162 话题词复用闸' },
  { name: 'agent_interrupt_addressed_total', where: 'round 177 interrupt 分桶' },
  { name: 'agent_interrupt_background_total', where: 'round 177 interrupt 分桶' },
  { name: 'answered_stamp_read_total', where: 'round 38 账本打点' },
  { name: 'answered_stamp_written_total', where: 'round 38 账本打点' },
  { name: 'answered_same_second_skipped_total', where: 'round 38 账本打点' },
  { name: 'answered_legacy_format_total', where: 'round 38 账本打点' },
  { name: 'llm_inflight_cap_skipped_total', where: 'round 198 在飞上限' },
  { name: 'llm_short_cooldown_total', where: 'round 182 冷却分级' },
];

describe('新计数器都真的会导出', () => {
  for (const c of NEW_COUNTERS) {
    it(`${c.name}（${c.where}）`, () => {
      // 用一个别的测试没用过的 label 值，避免撞名
      incrCounter(c.name, { probe: 'round65' });
      const out = renderMetrics();
      expect(out, `${c.name} 调了 incrCounter 却没出现在 renderMetrics 里`).toContain(c.name);
      // 且带上了我们给的 label（证明不是别的同名计数器的残留）
      expect(out).toContain('probe="round65"');
    });
  }

  it('每个计数器在 src/ 里都有一个真实的调用点（round 64 那个坑：写了没接上）', () => {
    // 上面那些只证明"incrCounter 能导出任意名字"——那是 registry 自己的性质，
    // 不是"我们的代码真的在调它"。round 64 的字段没初始化正是这一类：
    // 代码在、数字恒 0。所以这里 grep 调用点。
    //
    // round 66 补：命中的形状有两种——直接 `incrCounter('name', ...)`，
    // 和三元/变量 `incrCounter(cond ? 'a' : 'b', ...)`（session.ts 的 interrupt 分桶）。
    // 只 grep 前者会把后者误报成"没接上"（我这轮就被误报了一次）。
    const missing: string[] = [];
    for (const c of NEW_COUNTERS) {
      const direct = execSync(
        `grep -rl "incrCounter('${c.name}'" src/ --include=*.ts || true`,
        { encoding: 'utf8' },
      ).trim();
      const indirect = execSync(
        `grep -rl "'${c.name}'" src/ --include=*.ts | xargs grep -l incrCounter || true`,
        { encoding: 'utf8' },
      ).trim();
      if (!direct && !indirect) missing.push(c.name);
    }
    expect(missing, '这些计数器在 src/ 里没有调用点（写了没接上）：\n' + missing.join('\n')).toEqual([]);
  });

  it('renderMetrics 的格式是 Prometheus text exposition（# TYPE 行）', () => {
    incrCounter('send_task_burst_total', { probe: 'fmt' });
    const out = renderMetrics();
    expect(out).toContain('# TYPE send_task_burst_total counter');
  });
});
