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

  it('reply prompt encourages two short messages when more natural than one long message', () => {
    const prompt = readPrompt('task/reply.md');

    expect(prompt).toContain('优先输出 2 条');
    expect(prompt).toContain('一般最多 2 条');
  });

  it('reply prompt: 多个不同的人问不同的事 → 必须分人各回一条(不揉成一句)', () => {
    const prompt = readPrompt('task/reply.md');
    // C:强指令,防被改软回"想圆回去就"
    expect(prompt).toContain('必须分人各回一条');
    expect(prompt).toContain('绝对不要把要回给好几个人的话揉进一条');
  });

  it('judge prompt has no tier references (REPLY_PRO/REPLY_MAX removed)', () => {
    const prompt = readPrompt('task/judge.md');

    expect(prompt).not.toContain('REPLY_MAX');
    expect(prompt).not.toContain('REPLY_PRO');
    expect(prompt).not.toContain('replyTier');
  });

  it('H0: no servant language anywhere (主人≠主子，亲近但不跪)', () => {
    const files = [
      'identity/persona.md',
      'identity/behavior-style.md',
      'style/tone.md',
      'safety/guardrails.md',
      'task/judge.md',
      'task/reply.md',
      'task/planner.md',
      'task/codeact-reply.md',
    ];
    const banned = ['软下来', '软一点、听话', '还是帮你办', '不反驳不解释', '绝不犟', '立刻停'];
    for (const f of files) {
      const prompt = readPrompt(f);
      for (const b of banned) {
        expect(prompt, `${f} contains servant phrase: ${b}`).not.toContain(b);
      }
    }
  });

  it('H0: equal-footing markers present (别跪/棱角/拒绝权)', () => {
    expect(readPrompt('identity/persona.md')).toContain('主人≠主子');
    expect(readPrompt('identity/persona.md')).toContain('我的棱角');
    expect(readPrompt('task/reply.md')).toContain('直接指令要掂量');
    expect(readPrompt('task/judge.md')).toContain('不跪');
  });
});
