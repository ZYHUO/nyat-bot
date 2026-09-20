/**
 * 按沙盒能力改写 subagent 系统提示。
 *
 * 2026-09-21 加。`computer.run` 依赖 bwrap userns 隔离，而目标机器的 apt 源里
 * **没有 bwrap 包**。于是 executeCommand 每次都返回 `sandbox isolation
 * unavailable`，而 EXECUTOR_SYSTEM 里两处仍在推荐它——
 * **prompt 在推荐一个永久坏掉的能力**。
 *
 * 这里锁四件事：
 *   ① 隔离不可用 → 两处推荐都改写成本机没有
 *   ② 隔离可用 → 一字不改（bwrap 装回来就自动恢复）
 *   ③ 终端没启用 → 不改（那是另一个状态，不该混）
 *   ④ prompt 里找不到原文 → 安静返回，不抛（prompt 重构不该让所有任务失败）
 */
import { describe, it, expect } from 'vitest';
import { applySandboxAvailabilityNotes } from '../../../src/subagent/sandbox-prompt.js';

/** 与 EXECUTOR_SYSTEM 里那两行同文的 minimal prompt。 */
const PROMPT = [
  '可用全局对象:',
  '- computer.run(command) — 执行终端命令，返回 {stdout, stderr, exitCode}',
  '- browser.open(url)',
  '',
  '8. 写文件后建议用 computer.run 验证内容正确，再用 browser 验证效果。',
].join('\n');

const DEAD = { terminalEnabled: true, isolationRequired: true, bwrapAvailable: false };
const ALIVE = { terminalEnabled: true, isolationRequired: true, bwrapAvailable: true };

describe('applySandboxAvailabilityNotes', () => {
  it('① 隔离不可用 → computer.run 的文档行改写成"本机不可用"', () => {
    const out = applySandboxAvailabilityNotes(PROMPT, DEAD);
    expect(out).toContain('本机不可用');
    expect(out).toContain('bwrap 未安装');
    expect(out).not.toContain('执行终端命令，返回 {stdout, stderr, exitCode}');
  });

  it('①b 隔离不可用 → 第 8 步的"建议用 computer.run 验证"也改写', () => {
    const out = applySandboxAvailabilityNotes(PROMPT, DEAD);
    expect(out).not.toMatch(/建议用 computer\.run/);
    expect(out).toContain('写文件后没法用终端验证');
  });

  it('①c 改写后不再把 computer.run 说成可用（防回归：别把"不可用"三个字删了）', () => {
    const out = applySandboxAvailabilityNotes(PROMPT, DEAD);
    const runLines = out.split('\n').filter((l) => l.includes('computer.run'));
    expect(runLines.length).toBeGreaterThan(0);
    for (const l of runLines) expect(l).toMatch(/不可用|没法用/);
  });

  it('② 隔离可用 → 一字不改', () => {
    const out = applySandboxAvailabilityNotes(PROMPT, ALIVE);
    expect(out).toBe(PROMPT);
  });

  it('②b bwrap 可用时即使终端开着也不改写（装回来就自动恢复）', () => {
    expect(applySandboxAvailabilityNotes(PROMPT, { ...DEAD, bwrapAvailable: true })).toBe(PROMPT);
  });

  it('③ 终端没启用 → 不改（"没开"和"开了但坏了"是两个状态）', () => {
    expect(applySandboxAvailabilityNotes(PROMPT, { ...DEAD, terminalEnabled: false })).toBe(PROMPT);
  });

  it('③b 不要求隔离 → 不改（宿主回退是明确配置的，不是事故）', () => {
    expect(applySandboxAvailabilityNotes(PROMPT, { ...DEAD, isolationRequired: false })).toBe(PROMPT);
  });

  it('④ prompt 里找不到原文 → 安静返回，不抛', () => {
    const weird = '你是 subagent。没有 computer.run 这一行。';
    expect(() => applySandboxAvailabilityNotes(weird, DEAD)).not.toThrow();
    expect(applySandboxAvailabilityNotes(weird, DEAD)).toBe(weird);
  });

  it('④b 只找到其中一处 → 改那一处，另一处不影响', () => {
    const half = '- computer.run(command) — 执行终端命令，返回 {stdout, stderr, exitCode}\n没有第 8 步。';
    const out = applySandboxAvailabilityNotes(half, DEAD);
    expect(out).toContain('本机不可用');
    expect(out).toContain('没有第 8 步。');
  });

  it('⑤ 空 prompt 不炸', () => {
    expect(applySandboxAvailabilityNotes('', DEAD)).toBe('');
  });
});
