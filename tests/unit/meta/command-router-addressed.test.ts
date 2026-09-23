import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 命令路由必须要求寻址（round 167，计划第 0 步）。
 *
 * 2026-09-23 15:05 现场：`global-warp有无搞头`（没 @ 没回复）
 * 触发了 /geo 代发 → 用户抱怨「不会用别的 bot」。
 * 真根因不是捏造参数，是闲聊能借到命令。
 */
describe('command router 要求寻址', () => {
  const SRC = 'src/meta/ingress-intercepts.ts';

  const block = (): string => {
    const s = fs.readFileSync(SRC, 'utf8');
    const lines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    const i = lines.findIndex((l) => l.includes('routerEligible'));
    expect(i).toBeGreaterThan(-1);
    return lines.slice(i, i + 20).join('\n');
  };

  it('① 寻址才路由（用全仓同一个判据 opts.isDirect，不新造信号）', () => {
    const b = block();
    expect(b).toContain('if (opts.isDirect) {');
    expect(b).toContain('routeLearnedCommand(chatId, formatted)');
  });

  it('② 没寻址时有计数器 + info 日志（round 75 家族：跳过也要可观测）', () => {
    const b = block();
    expect(b).toContain('command_router_skip_unaddressed_total');
    expect(b).toContain('logger.info');
    expect(b).toContain('command router: skipped');
  });

  it('③ isDirect 的含义没被窄化（点名/昵称/回复 bot/自身是命令都在内）', () => {
    // 判据来自 detectDirectInteraction，这个测试钉住"没有另造一个更严的寻址定义"
    const d = fs.readFileSync('src/pipeline/timing/direct-interaction.ts', 'utf8');
    const code = d.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    for (const kind of ["return 'mention'", "return 'nickname'", "return 'reply_to_bot'", "return 'command'"]) {
      expect(code.some((l) => l.includes(kind))).toBe(true);
    }
  });

  it('④ routeLearnedCommand 只在 isDirect 分支里被调（没被挪到 else）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const lines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    const gateIdx = lines.findIndex((l) => l.includes('routerEligible'));
    expect(gateIdx).toBeGreaterThan(-1);
    const after = lines.slice(gateIdx);
    const directIdx = after.findIndex((l) => l.includes('if (opts.isDirect) {'));
    const callIdx = after.findIndex((l) => l.includes('routeLearnedCommand('));
    const elseIdx = after.findIndex((l) => l.trim() === '} else {');
    expect(directIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(directIdx);
    // else（跳过）分支在调用之后，且里面只有观测、没有再调一次
    expect(elseIdx).toBeGreaterThan(callIdx);
    const elseBody = after.slice(elseIdx + 1, elseIdx + 8).join('\n');
    expect(elseBody).not.toContain('routeLearnedCommand');
  });
});
