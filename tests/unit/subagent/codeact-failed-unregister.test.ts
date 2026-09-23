import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';

/**
 * round 102: **\u8d85\u65f6\u7684 CodeAct job \u5fc5\u987b\u89e3\u6389 chat \u7d22\u5f15\u3002**
 *
 * \u73b0\u573a\uff1atask 25249feb \u5728 09-23 18:51 UTC `job stalled more than allowable limit`
 * \u5931\u8d25\uff0c\u4f46 `xxb:agent:active-chat:{chat}`\uff0824h TTL\uff09\u6ca1\u6e05\u2014\u2014
 * `unregisterAgentChat` \u53ea\u5728 executor \u7684\u6b63\u5e38\u7ec8\u6001 / \u5f02\u5e38\u9003\u9010\u4e24\u6761\u8def\u5f84\u4e0a\u8c03\uff0c
 * \u800c **stall \u7684\u539f\u8fdb\u7a0b\u6839\u672c\u6ca1\u8fd4\u56de**\u3002
 *
 * \u540e\u679c\uff1a4.5 \u5c0f\u65f6\u91cc 23 \u6761\u7fa4\u6d88\u606f\u5168\u88ab\u5f53\u6210 interrupt\uff0c\u5176\u4e2d 9 \u6761
 * `background`\uff08\u6ca1\u4eba\u5728\u8ddf\u5b83\u8bf4\u8bdd\uff09\u2014\u2014\u8fd9\u5c31\u662f\u7528\u6237\u8bf4\u7684\u201c\u5e94\u6fc0\u201d\u7684\u4e00\u4e2a\u5177\u4f53\u6765\u6e90\u3002
 *
 * \u4e24\u4e2a key \u4e0d\u540c\uff1a
 *   `xxb:codeact:active:`      \u2190 isCodeActBusy \u7528\uff08finally \u91cc\u6e05\uff09
 *   `xxb:agent:active-chat:`   \u2190 interrupt \u8def\u7531\u7528\uff08**\u4ece\u6ca1\u88ab\u6e05\u8fc7**\uff09
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
