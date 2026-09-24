import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 105: **残留的活动任务索引要有自慈摧拦。**
 *
 * 故事\uff08round 102-105\uff09：CodeAct job `stalled more than allowable limit` 失败，
 * 但 hash 里 status 还是 running、active-chat 索引还在——
 * 5 小时里 23 来群消息被当成 interrupt\uff0818 条 background\uff09。
 *
 * Round 103 修的是"未来的 failed 要清"，已经坏掉的没人管。
 * 这个摧拦补那一半\uff0b而且顺便治另外一种形态\uff08hash 先过期、索引后过期\uff09。
 *
 * 最重要的边界：**`waiting_user` 不能清**——它合法地在等人，
 * 可能等很久。round 67 那条\uff08不要治不会发生的病\uff09在这里同样适用。
 */

const SRC = 'src/cron/restart-hygiene.ts';

const code = (): string[] =>
  fs.readFileSync(SRC, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//'));

describe('残留活动任务清扫', () => {
  it('① sweepStaleAgentTasks 存在且 exported', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('export async function sweepStaleAgentTasks');
  });

  it('② 扫 xxb:agent:active-chat:* 这个索引（round 104 我查错过库，这里钉死 key 名）', () => {
    const c = code();
    expect(c.some((l) => l.includes("xxb:agent:active-chat:*"))).toBe(true);
  });

  it('③ waiting_user **不清**（边界：它合法地在等人）', () => {
    // round 105: 第一片拿到的是块注释里的一段说明（我在注释里也写了
    // "status 是 running/queued"）——块注释内的行不以 // 开头， code() 滤不掉。
    // 改成读真代码：从函数体开头开始取。
    const c = code();
    const i = c.findIndex((l) => l.includes('for (const k of keys)'));
    expect(i, 'sweep 主循环不在').toBeGreaterThan(-1);
    const after = c.slice(i, i + 20).join('\n');
    expect(after).toContain("status !== 'running'");
    expect(after).toContain("status !== 'queued'");
    // 且不得出现 waiting_user 的排除写反了（即不能说 '!== waiting_user' 继续）
    expect(after).not.toContain("!== 'waiting_user'");
  });

  it('④ hash 里已消失的索引也清（形态 B：TTL 不同步）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('if (!t)');
    expect(i, '没有处理 task 已消失的分支').toBeGreaterThan(-1);
    const after = s.slice(i, i + 200);
    expect(after).toContain('del(k)');
  });

  it('⑤ 阈值 2 小时且是常量（不是配置，也不是 0——round 85 同款教训）', () => {
    const c = code();
    const line = c.find((l) => l.includes('STALE_TASK_SEC') && l.includes('='));
    expect(line, 'STALE_TASK_SEC 常量不在').toBeDefined();
    expect(line!).toMatch(/2 \* 3600/);
  });

  it('⑥ 清了要打 warn 日志（round 191：不可见 = 没发生过）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('stale running task swept');
  });

  it('⑦ scheduler 真注册了它（round 173 同款：不是只定义了模块）', () => {
    const s = fs.readFileSync('src/cron/scheduler.ts', 'utf8');
    const c = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(c.some((l) => l.includes('stale-agent-sweep'))).toBe(true);
    expect(c.some((l) => l.includes('sweepStaleAgentTasks'))).toBe(true);
  });
});

describe('sweep 的健康日志（round 110）', () => {
  it('⑧ 健康时也打 info（否则"扫了 0 次"和"从没跑过"分不清）', () => {
    const s = fs.readFileSync('src/cron/restart-hygiene.ts', 'utf8');
    // 必须在 return 之前，且带 checked/cleared 两个字段
    const i = s.indexOf('agent sweep: stale running-task indexes scanned');
    expect(i, '健康日志不在').toBeGreaterThan(-1);
    const before = s.slice(Math.max(0, i - 400), i);
    expect(before).toContain('logger.info');
    expect(before).toContain('checked');
    expect(before).toContain('cleared');
    // 且在 return { cleared, checked } 之前（不是死代码）
    const ret = s.indexOf('return { cleared, checked }', i);
    expect(ret, '日志写在 return 之后 = 死代码').toBeGreaterThan(i);
  });

  it('⑨ 频率是小时级（不能变成刷屏）', () => {
    const s = fs.readFileSync('src/cron/scheduler.ts', 'utf8');
    const i = s.indexOf('stale-agent-sweep');
    const line = s.slice(i, s.indexOf('\n', i));
    expect(line).toMatch(/everySec: 3600/);
  });
});


describe('sweep 在启动时也跑一次（round 114）', () => {
  it('⑩ startCronJobs 里直接调 sweepStaleAgentTasks（不等第一个小时）', () => {
    const s = fs.readFileSync('src/cron/scheduler.ts', 'utf8');
    const c = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    // 注册之外还要有一次裸调用
    const calls = c.filter((l) => l.includes('sweepStaleAgentTasks()'));
    expect(calls.length, `只有 ${calls.length} 处调用（需要 ≥2：注册 + 启动）`).toBeGreaterThanOrEqual(2);
  });

  it('⑪ 它不能抛（void + catch，否则拖垮启动链）', () => {
    const s = fs.readFileSync('src/cron/scheduler.ts', 'utf8');
    // round 114: 第一片用 lastIndexOf 找到了 reg 行里的子串。
    // 改成找带 `void ` 的那一行本身。
    const line = s.split('\n').find((l) => /\bvoid\s+sweepStaleAgentTasks/.test(l));
    expect(line, '找不到启动时的 void 调用').toBeDefined();
    expect(line!).toMatch(/void\s+sweepStaleAgentTasks\(\)\.catch/);
  });
});
