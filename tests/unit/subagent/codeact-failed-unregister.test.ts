import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 102: **超时的 CodeAct job 必须解掉 chat 索引。**
 *
 * 现场：task 25249feb 在 09-23 18:51 UTC `job stalled more than allowable limit`
 * 失败，但 `xxb:agent:active-chat:{chat}`\uff0824h TTL\uff09没清——
 * `unregisterAgentChat` 只在 executor 的正常终态 / 异常逃逐两条路径上调，
 * 而 **stall 的原进程根本没返回**。
 *
 * 后果：4.5 小时里 23 条群消息全被当成 interrupt，其中 9 条
 * `background`\uff08没人在跟它说话\uff09——这就是用户说的“应激”的一个具体来源。
 *
 * 两个 key 不同：
 *   `xxb:codeact:active:`      \u2190 isCodeActBusy 用\uff08finally 里清\uff09
 *   `xxb:agent:active-chat:`   \u2190 interrupt 路由用\uff08**从没被清过**\uff09
 */

const SRC = 'src/subagent/queue.ts';

const code = (): string[] => fs.readFileSync(SRC, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//'));

describe('CodeAct job 失败时解掉 chat 索引', () => {
  it('① failed handler 里调 unregisterAgentChat（round 102 前只 logger.warn）', () => {
    const c = code();
    const i = c.findIndex((l) => l.includes("'CodeAct job failed'"));
    expect(i, 'failed handler 不在').toBeGreaterThan(-1);
    const after = c.slice(i, i + 45).join('\n');
    // round 102: 第一片用 toContain('unregisterAgentChat') 被 import 行带绿了
    // （文件里这个词出现 3 次：注释 1 + import 1 + 调用 1）。
    // 改成认抢调用本身：`unregisterAgentChat(d.chatId, d.id)`。
    expect(after, 'failed handler 后面没有真正调用 unregisterAgentChat').toContain('unregisterAgentChat(d.chatId');
  });

  it('② 也调 clearCodeActActive（两个 key 都要清，round 102 实测它们不同）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf("'CodeAct job failed'");
    const after = s.slice(i, i + 1600);
    expect(after).toContain('clearCodeActActive');
  });

  it('③ 把 task status 改成 failed（只清 key 不够：interrupt 路由会查 status）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf("'CodeAct job failed'");
    const after = s.slice(i, i + 2000);
    expect(after).toContain("t.status = 'failed'");
  });

  it('④ 清理解释写了 round 102 的现场（否则下一个人当多余代码删掉）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('round 102');
    expect(s).toContain('stalled more than allowable limit');
  });

  it('⑤ 清理失败不抛出（catch 包着，不能反过来把 worker 拒了）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('round 102');
    const after = s.slice(i, i + 1800);
    expect(after).toContain('catch');
  });
});
