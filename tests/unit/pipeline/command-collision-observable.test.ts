import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 撞名守卫必须可数（round 87）。
 *
 * round 84 我说"撞名守卫 0 触发 = 无法验证"。查下去发现它在**快路径**上：
 * Jev 有信心的命中 + 命中撞名命令 + 消息没点名 → 不代发，回落 LLM judge。
 * 而 `jev: ok` 今天 2706 次——它可能每天都在拦几十次，
 * 但那条日志是 `logger.debug`，生产 `LOG_LEVEL=info` 下不可见。
 *
 * 所以"0 触发"不是"没问题"，是**看不见**。
 * 这和代发目标不在群（round 84）是同一处：那个补了 info 日志后 1 分钟
 * 就挡住一次（round 86）。
 */
describe('撞名守卫的可观测性', () => {
  const SRC = 'src/pipeline/command-router.ts';

  it('① 挡住时打 info（不再走 debug）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('撞名命令未显式指定');
    const i = s.indexOf('撞名命令未显式指定');
    const before = s.slice(Math.max(0, i - 200), i);
    expect(before).toContain('logger.info');
    expect(before).not.toContain('logger.debug');
  });

  it('② 有计数器', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('command_collision_guard_total');
    expect(s).toContain('incrCounter');
  });

  it('③ 带了 preview（能看出拦的是不是闲聊提词）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('preview: text.slice(0, 60)');
  });

  it('④ 行为没变：仍返回 unsure（回落 LLM judge）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("return { kind: 'unsure', latencyMs: ans.latencyMs };");
  });

  it('⑤ 判据没变：OWN_COMMANDS + !namesBot', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('OWN_COMMANDS.has(hit.command.toLowerCase())');
    expect(s).toContain('!namesBot(text, hit.bot)');
  });
});
