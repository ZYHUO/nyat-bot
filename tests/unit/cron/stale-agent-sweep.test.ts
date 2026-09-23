import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 105: **\u6b8b\u7559\u7684\u6d3b\u52a8\u4efb\u52a1\u7d22\u5f15\u8981\u6709\u81ea\u6148\u6467\u62e6\u3002**
 *
 * \u6545\u4e8b\uff08round 102-105\uff09\uff1aCodeAct job `stalled more than allowable limit` \u5931\u8d25\uff0c
 * \u4f46 hash \u91cc status \u8fd8\u662f running\u3001active-chat \u7d22\u5f15\u8fd8\u5728\u2014\u2014
 * 5 \u5c0f\u65f6\u91cc 23 \u6765\u7fa4\u6d88\u606f\u88ab\u5f53\u6210 interrupt\uff0818 \u6761 background\uff09\u3002
 *
 * Round 103 \u4fee\u7684\u662f"\u672a\u6765\u7684 failed \u8981\u6e05"\uff0c\u5df2\u7ecf\u574f\u6389\u7684\u6ca1\u4eba\u7ba1\u3002
 * \u8fd9\u4e2a\u6467\u62e6\u8865\u90a3\u4e00\u534a\uff0b\u800c\u4e14\u987a\u4fbf\u6cbb\u53e6\u5916\u4e00\u79cd\u5f62\u6001\uff08hash \u5148\u8fc7\u671f\u3001\u7d22\u5f15\u540e\u8fc7\u671f\uff09\u3002
 *
 * \u6700\u91cd\u8981\u7684\u8fb9\u754c\uff1a**`waiting_user` \u4e0d\u80fd\u6e05**\u2014\u2014\u5b83\u5408\u6cd5\u5730\u5728\u7b49\u4eba\uff0c
 * \u53ef\u80fd\u7b49\u5f88\u4e45\u3002round 67 \u90a3\u6761\uff08\u4e0d\u8981\u6cbb\u4e0d\u4f1a\u53d1\u751f\u7684\u75c5\uff09\u5728\u8fd9\u91cc\u540c\u6837\u9002\u7528\u3002
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
