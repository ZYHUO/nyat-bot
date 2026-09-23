import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * session-report 必须有"每任务开口次数"维度（round 174）。
 *
 * k3 round 173 判定：现有 taskSends 数的是 task delivery recorded，而实验表明
 * 它既不是调用也不是气泡（5734 次调用 / 964 片 / 5189 条 delivery）——
 * 所以"超过 6 条的尾巴 13/907"是**分片副产物**，不是预算失灵。
 *
 * 而 task 级 burst 闸（TASK_BURST_GAP_SEC）治的是"一个任务开了几次口"，
 * 那个维度此前**没有量具**。
 */
describe('session-report 的开口维度', () => {
  const SRC = 'scripts/session-report.mts';

  it('① 采集 host sendText 的 taskId（round 170 才有的字段）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.some((l) => l.includes("msg === 'host sendText' && d['taskId']"))).toBe(true);
    expect(code.some((l) => l.includes('st.taskCalls.set(tid,'))).toBe(true);
  });

  it('② 输出在 printTaskDistribution 函数体内（不在 main 里）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    // 用花括号配结对出函数体范围——第一版查"在函数名之后"，
    // 而插到 main 的沉睡警告前也满足（round 174 实测 tamper 不红）。
    const lines = s.split('\n');
    const start = lines.findIndex((l) => l.startsWith('function printTaskDistribution('));
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]!) {
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > -1) break;
    }
    expect(end, '没配平到函数结尾').toBeGreaterThan(start);
    const body = lines.slice(start, end + 1);
    expect(body.some((l) => l.includes('每任务开口次数'))).toBe(true);
    // 沉睡警告是 main 里的东西，不该跑到函数体内
    expect(body.some((l) => l.includes('bot 已沉睡'))).toBe(false);
  });

  it('③ 空数据时说清"为什么空"，不报 0%（round 92 的教训）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('没有带 taskId 的发送');
    expect(s).toContain('round 170 起才有，旧日志为空');
  });

  it('④ 阈值是 2 次开口（burst 闸治的是 >= 2 次）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('n > 2');
    expect(s).toContain('burst 闸要治的就是这批');
  });

  it('⑤ 调用处把 taskCalls 传进去了（只加参数不传就是死维度）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('printTaskDistribution(st.taskSends, st.taskCalls)');
  });

  it('⑥ 部署后的那套 key 也维护（和 taskSends 同一形状）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("st.taskCalls.set(`@${tid}`");
  });
});
