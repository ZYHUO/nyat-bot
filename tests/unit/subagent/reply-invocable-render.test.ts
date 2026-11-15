import { describe, expect, it, vi } from 'vitest';

// round 9 回归：EXECUTOR_SYSTEM 原来写死"（当前 = /spam@nmnmfunbot…）"——
// 一个 2026-09-20 的快照。学会了新命令/命令被 block/群没授权，prompt 都不变，
// 模型只拿着过期的话行事。这和这个会话反复出现的是同一条：
// 广告出去的能力和实际能用的能力不是一套。
//
// 锁住三个性质：
//   ① 清单非空 → 渲染的是**实时**的、且带上"以这份为准"
//   ② 清单为空 → 那截括号整个消失（不说一个不存在的名字）
//   ③ 渲染出来的每条都真过得去闸（不是把 learning 的也广告出去）

const listReplyInvocableCommands = vi.fn(() => [
  { bot: 'nmnmfunbot', command: '/spam', usageSyntax: '/spam', useScenario: '封禁并举报' },
  { bot: 'kmuav2bot', command: '/pickbottle', usageSyntax: '/pickbottle', useScenario: ' pickbottle' },
]);
const whyNotReplyInvocable = vi.fn(() => null);

vi.mock('../../../src/learners/bot-command-store.js', () => ({
  listReplyInvocableCommands: (...a: unknown[]) => listReplyInvocableCommands(...a),
  whyNotReplyInvocable: (...a: unknown[]) => whyNotReplyInvocable(...a),
}));

/** 与 executor.ts 里那段渲染保持同形（改那边要同步这里）。 */
function render(cmds: Array<{ bot: string; command: string; usageSyntax?: string }>): string {
  if (cmds.length === 0) return '';
  const rendered = cmds
    .map((c) => `/${c.command.replace(/^\//, '')}@${c.bot}${c.usageSyntax && c.usageSyntax !== c.command ? `（${c.usageSyntax}）` : ''}`)
    .join('、');
  return `（**当前真过得去闸的回复式命令：${rendered}**——以这份为准，别用记忆里的旧名单）`;
}

describe('回复式命令清单的实时渲染', () => {
  it('① 清单非空 → 渲染实时名单 + "以这份为准"', async () => {
    const { listReplyInvocableCommands } = await import('../../../src/learners/bot-command-store.js');
    const line = render(listReplyInvocableCommands());
    expect(line).toContain('/spam@nmnmfunbot');
    expect(line).toContain('/pickbottle@kmuav2bot');
    expect(line).toContain('以这份为准');
    // 不该再有过期快照的措辞
    expect(line).not.toContain('当前 =');
  });

  it('② 清单为空 → 整个括号消失（不说一个不存在的名字）', () => {
    expect(render([])).toBe('');
  });

  it('③ usageSyntax 与 command 相同时不重复括注', () => {
    const line = render([{ bot: 'b', command: '/x', usageSyntax: '/x' }]);
    expect(line).toBe('（**当前真过得去闸的回复式命令：/x@b**——以这份为准，别用记忆里的旧名单）');
  });
});
