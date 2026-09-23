import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * task 级 burst 闸（round 171，计划 3c 提前）。
 *
 * 现场：一个任务 51 秒内 4 次 sendText 调用 → 11 个气泡，用户抱怨"说话太应激"。
 * k3 2026-09-24 裁决：不能用 MIN_GAP_ADDRESSED_SEC（chat 级，且 30s 是 round 68
 * 被用户否决过的值），也不能用 AGENT_TASK_SEND_BUDGET（终身总额，调小会走
 * failsafe → raw sendMessage → 绕过全部闸 → 用户收到假失败）。task 级是正解。
 */
describe('task 级 burst 闸', () => {
  const SRC = 'src/subagent/host-api.ts';

  const gate = (): string => {
    const s = fs.readFileSync(SRC, 'utf8');
    const lines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    const i = lines.findIndex((l) => l.includes('send_task_burst_total'));
    expect(i).toBeGreaterThan(-1);
    return lines.slice(Math.max(0, i - 12), i + 14).join('\n');
  };

  it('① 判据是 taskId + 距上次调用 < N 秒（不是 chat 级、不是终身总额）', () => {
    // round 142 的教训：字符串在场不等于机制在跑。必须查**条件行本身**——
    // 第一版只查 region 里有 'opts.taskId'，而把 if 改成 `if (false && opts.taskId)`
    // 之后测试照样绿（那些字还在，只是不执行了）。
    const s = fs.readFileSync(SRC, 'utf8');
    const lines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    // 直接找"if (opts.taskId) {"那一行：它必须存在、且下一行就去取 redis
    // （= 这个 if 的的确确是 burst 闸的入口，不是别处的同名判断）。
    // 把条件改成 `if (false && opts.taskId)` 时这行不再匹配 → 红。
    // round 171 第二版：结构是"if (opts.taskId) { try { ...取 redis 读键... } catch fail-open }"
    // 然后是 try 外的 `if (burstGap !== null) { ...throw }`。
    // 这么认是为了同时防两种弄坏：禁用 if、或把 throw 挪回 try 里（自我吞掉）。
    const guardIdx = lines.findIndex(
      (l, i) => l.trim() === 'if (opts.taskId) {' && (lines[i + 1] ?? '').trim() === 'try {',
    );
    expect(guardIdx, 'burst 闸的 if (opts.taskId) { 入口不在/被禁用').toBeGreaterThan(-1);
    const after = lines.slice(guardIdx, guardIdx + 30).join('\n');
    expect(after).toContain('await import');
    expect(after).toContain('taskLastSendKey(opts.taskId)');
    // throw 必须在判定用的 try 之外（否则自己的 catch 吞掉它，闸永生效不了）
    const tryIdx = after.indexOf('try {');
    const catchIdx = after.indexOf('} catch (err) {');
    const throwIdx = after.indexOf('throw new Error(');
    expect(throwIdx).toBeGreaterThan(catchIdx);
    expect(catchIdx).toBeGreaterThan(tryIdx);
    expect(gate()).toContain('TASK_BURST_GAP_SEC');
  });

  it('② 拦下来时抛回模型看（不是静默丢弃）+ 计数器 + info', () => {
    const g = gate();
    expect(g).toContain('throw new Error');
    expect(g).toContain('send_task_burst_total');
    expect(g).toContain('logger.info');
    expect(g).toContain('rejected task burst');
  });

  it('③ 文案让模型合并或收尾，且说明这是宿主软闸', () => {
    const g = gate();
    expect(g).toContain('并成一条');
    expect(g).toContain('宿主软闸');
  });

  it('④ 键只在调用完成后写一次，不在分片上写（round 71 的理由）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const lines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    const w = lines.findIndex((l) => l.includes('taskLastSendKey(burstTaskId)'));
    expect(w).toBeGreaterThan(-1);
    // 写的上下文应是 lastMessageId 赋值处（一次调用的终点），不是 parts 循环体首
    const region = lines.slice(Math.max(0, w - 6), w + 8).join('\n');
    expect(region).toContain('lastMessageId = messageId');
  });

  it('⑤ 阈值常量存在且给的是保守值（10~15 区间）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const m = s.match(/const TASK_BURST_GAP_SEC = (\d+);/);
    expect(m).not.toBeNull();
    const v = Number(m![1]);
    expect(v).toBeGreaterThanOrEqual(10);
    expect(v).toBeLessThanOrEqual(15);
  });

  it('⑥ 注释写明为什么不另两个旋钮（否则下一轮又把 3b 当方案）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('round 171（计划 3c 提前）');
    expect(i).toBeGreaterThan(-1);
    const block = s.slice(i, i + 900);
    expect(block).toContain('MIN_GAP_ADDRESSED_SEC');
    expect(block).toContain('AGENT_TASK_SEND_BUDGET');
    expect(block).toContain('round 68');
  });

  it('⑦ 闸在 trench gate 之前（两个轴分开判，先 task 级再 chat 级）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const burst = s.indexOf('send_task_burst_total');
    const trench = s.indexOf('BLOCKED by trench gate (active speech)');
    expect(burst).toBeGreaterThan(-1);
    expect(trench).toBeGreaterThan(burst);
  });
});
