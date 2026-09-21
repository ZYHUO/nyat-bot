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
import { readFileSync } from 'node:fs';
import { applySandboxAvailabilityNotes } from '../../../src/subagent/sandbox-prompt.js';

/**
 * 与 EXECUTOR_SYSTEM 里那几行同文的 minimal prompt。
 * 2026-09-21 补了另外三处：小节标题、python3.10/PIL 建议、grep 检查办法——
 * 它们同样依赖终端，第一版只改了前两处，剩下的仍在向模型推荐死路。
 */
const PROMPT = [
  '可用全局对象:',
  '- computer.run(command) — 执行终端命令，返回 {stdout, stderr, exitCode}',
  '- browser.open(url)',
  '',
  '## 电脑使用（SANDBOX_ENABLED 时可用）',
  '- computer.writeFile(path, content) — 写文件到沙盒目录',
  '- **图像处理（改尺寸/裁剪/转格式/处理真实照片）用 python3.10（有 PIL），不是 python3（没有 PIL）**。例：python3.10 -c "from PIL import Image; ..."。注意：**画图创作（画券/画头像/画海报）不走这里，用 art.draw**',
  '',
  '8. 写文件后建议用 computer.run 验证内容正确，再用 browser 验证效果。',
  '   - **写 HTML 必须带头 `<meta charset="UTF-8">`**。检查办法：写完 grep charset，没有就补。CSS/JS 不需要。',
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

  // ─── 2026-09-21 补：另外三处依赖终端的建议 ─────────────────────────
  describe('其余依赖终端的建议', () => {
    it('⑥ 小节标题改写成"终端命令本机不可用"', () => {
      const out = applySandboxAvailabilityNotes(PROMPT, DEAD);
      expect(out).not.toContain('## 电脑使用（SANDBOX_ENABLED 时可用）');
      expect(out).toContain('终端命令本机不可用');
    });

    it('⑥b 不依赖终端的部分仍在（文件读写/浏览器没坏）', () => {
      const out = applySandboxAvailabilityNotes(PROMPT, DEAD);
      expect(out).toContain('computer.writeFile(path, content) — 写文件到沙盒目录');
      expect(out).toContain('browser.open(url)');
    });

    it('⑦ python3.10/PIL 建议改成本机做不了', () => {
      const out = applySandboxAvailabilityNotes(PROMPT, DEAD);
      expect(out).not.toContain('用 python3.10（有 PIL）');
      expect(out).toContain('图像处理（改尺寸/裁剪/转格式）本机做不了');
      // art.draw 的指引必须留下——那是替代路径
      expect(out).toContain('art.draw');
    });

    it('⑧ grep charset 的检查办法改写成人工核对', () => {
      const out = applySandboxAvailabilityNotes(PROMPT, DEAD);
      expect(out).not.toContain('检查办法：写完 grep charset');
      expect(out).toContain('grep 跑不了');
      // charset 要求本身不能丢——那是真需求
      expect(out).toContain('<meta charset="UTF-8">');
    });

    it('⑨ 隔离可用时这些一处都不改', () => {
      expect(applySandboxAvailabilityNotes(PROMPT, ALIVE)).toBe(PROMPT);
    });
  });
});

// ─── 组合校验：拿**真的** EXECUTOR_SYSTEM 过一遍改写器 ────────────────────
//
// 上面那些用例的 PROMPT 是手抄的。手抄就会漂——sandbox-prompt.ts 里那句
// "改 prompt 时这里必须同步，否则替换静默失效"说的就是这件事：正则可匹配不上的
// 时候，函数安静返回原文，而 prompt 还在向模型推荐一条死路。
//
// 2026-09-21 那次审计就是这么发现的：art.draw 在生产 0% 成功，它的兜底建议
// （python3.10 + PIL 走 computer.run）指向的终端永久不可用。改写器本身有覆盖
// PIL 那行，但**没有任何测试拿真 prompt 验过它匹配得上**。
//
// 所以这里直接从 executor.ts 里把模板原文掏出来跑一遍：这是唯一能证明
// "改写对当前这份 prompt 真的生效"的办法。
describe('组合：真 EXECUTOR_SYSTEM 过改写器', () => {
  const src = readFileSync('src/subagent/executor.ts', 'utf8');
  // 终止反引号独占一行（prompt 里的反引号全都转义成 \`），所以用 \n`; 收尾。
  const m = src.match(/const EXECUTOR_SYSTEM = `([\s\S]*?)\n`;/);
  const REAL = m ? m[1]!.replace(/\\`/g, '`') : '';

  it('掏得出真 prompt（掏不出来这条测试自己就该红）', () => {
    expect(REAL.length).toBeGreaterThan(2000);
    expect(REAL).toContain('art.draw(');
  });

  it('终端不可用 → 真 prompt 里不再有任何一处推荐死路', () => {
    const out = applySandboxAvailabilityNotes(REAL, DEAD);
    expect(out).not.toMatch(/建议用 computer\.run/);
    expect(out).not.toContain('用 python3.10（有 PIL）');
    expect(out).not.toContain('检查办法：写完 grep charset');
    // 每一处提到 computer.run 的行都必须自带"不可用/没法用"
    for (const line of out.split('\n').filter((l) => l.includes('computer.run'))) {
      expect(line).toMatch(/不可用|没法用/);
    }
    // 每一处提到 python3.10 的行都必须说明本机做不了
    for (const line of out.split('\n').filter((l) => l.includes('python3.10'))) {
      expect(line).toMatch(/做不了|不可用/);
    }
  });

  it('翻车之后，画图的正路仍在 prompt 里（art.draw 的指引一条都没被改写掉）', () => {
    const out = applySandboxAvailabilityNotes(REAL, DEAD);
    expect(out).toContain('art.draw(描述');
    expect(out).toContain('画图必须用它');
    expect(out).toContain('每任务限 2 次');
    // 图像处理那条被改写后仍指向 art.draw，而不是让模型去撸 PIL
    const pil = out.split('\n').find((l) => l.includes('图像处理'))!;
    expect(pil).toContain('art.draw');
  });

  it('终端可用 → 真 prompt 一字不改', () => {
    expect(applySandboxAvailabilityNotes(REAL, ALIVE)).toBe(REAL);
  });
});
