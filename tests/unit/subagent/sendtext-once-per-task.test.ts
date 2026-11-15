import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 工具描述必须告诉模型"一个任务对同一个 chat 只开口一次"（round 175）。
 *
 * k3 round 173 Step 3：宿主闸只是把结果扔回模型，模型换个说法重发，闸就永远
 * 在后面追。**必须同时给模型硬约束**，否则 burst 闸治标不治本。
 *
 * 现场：一个 CodeAct 任务 51 秒内 4 次调 sendText，共 11 个气泡，
 * 用户原话「说话太应激」。
 */
describe('sendText 的"一次任务只开口一次"约束', () => {
  const SRC = 'src/subagent/executor.ts';

  it('① 工具描述里有这句硬约束', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    // 只查工具清单那一行（不是别处的注释），因为约束要说给模型听
    const line = s.split('\n').find((l) => l.startsWith('- telegram.sendText(text, replyToMessageId?, kind?)'));
    expect(line, 'sendText 工具描述行不在').toBeDefined();
    expect(line!).toContain('一个任务对同一个 chat 只开口一次');
  });

  it('② 说明了正确的做法（并进同一条，用。分气泡）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const line = s.split('\n').find((l) => l.startsWith('- telegram.sendText(text, replyToMessageId?, kind?)'))!;
    expect(line).toContain('并进');
    expect(line).toContain('多个气泡');
  });

  it('③ 点了用户原话，让模型知道这不是风格偏好（否则会被当耳旁风）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const line = s.split('\n').find((l) => l.startsWith('- telegram.sendText(text, replyToMessageId?, kind?)'))!;
    expect(line).toContain('说话太应激');
  });

  it('④ 给了例外（中途吱一声），否则模型连过渡话都不敢说', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const line = s.split('\n').find((l) => l.startsWith('- telegram.sendText(text, replyToMessageId?, kind?)'))!;
    expect(line).toContain('例外');
    expect(line).toContain('吱一声');
  });

  it('⑤ 写在模板字符串里（不是 JS 注释，否则模型看不到）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const lines = s.split('\n');
    const idx = lines.findIndex((l) => l.startsWith('- telegram.sendText(text, replyToMessageId?, kind?)'));
    expect(idx).toBeGreaterThan(-1);
    // 工具清单是系统提示的一部分：往上应能找到它的标题行
    const above = lines.slice(Math.max(0, idx - 6), idx).join('\n');
    expect(above).toContain('可用全局对象');
  });
});
