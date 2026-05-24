import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readPrompt(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), 'prompts', relativePath), 'utf-8');
}

describe('reply prompt files', () => {
  it('reply prompt tells final writer to rely on provided tool results rather than self-calling tools', () => {
    const prompt = readPrompt('task/reply.md');

    expect(prompt).toContain('[TOOL_RESULTS]');
    expect(prompt).not.toContain('工具搜索');
    expect(prompt).not.toContain('直接调用');
  });

  it('reply-pro prompt tells final writer to rely on provided tool results rather than self-calling tools', () => {
    const prompt = readPrompt('task/reply-pro.md');

    expect(prompt).toContain('[TOOL_RESULTS]');
    expect(prompt).not.toContain('直接调用');
  });

  it('reply prompt encourages two short messages when more natural than one long message', () => {
    const prompt = readPrompt('task/reply.md');

    expect(prompt).toContain('优先输出 2 条');
    expect(prompt).toContain('一般最多 2 条');
  });

  it('reply-pro prompt encourages splitting long answers into two short messages', () => {
    const prompt = readPrompt('task/reply-pro.md');

    expect(prompt).toContain('优先拆成 2 条短消息');
    expect(prompt).toContain('一般最多 2 条');
  });

  it('judge prompt documents REPLY_MAX for deep reasoning decisions', () => {
    const prompt = readPrompt('task/judge.md');

    expect(prompt).toContain('REPLY_MAX');
    expect(prompt).toContain('replyTier=max');
  });
});
