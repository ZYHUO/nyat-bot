import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 截断重试必须可观测（round 75）。
 *
 * 2026-09-23。round 73/74 一个排不光的矛盾：`claude: 空正文` warn 打了
 * （证明确实进了 callClaudeOnce），但重试日志 `思维链吃光额度导致空正文`
 * 一条都没有。
 *
 * round 74 逐项验了十二环全对，结论仍矛盾。**最后发现是观测设计错误**：
 *
 *   const log = firstTime ? logger.info : logger.debug;
 *
 * 待诊断的事件被放在了会被 LOG_LEVEL=info 过滤掉的级别上。于是
 * "observed 0 条" 无法区分 **"没走到"** 和 **"走了但被过滤"**——
 * 这两种可能 corrective action 完全相反。
 *
 * 修：固定走 warn。截断是异常路径，且 round 72 后频率已被下限压住
 * （37.8 → 12.2 次/h），warn 不会刷屏。原注释"50 分钟 193 次"的顾虑
 * 是 1200 下限时代的事，现在不成立。
 */
describe('截断重试的可观测性', () => {
  const SRC = 'src/ai/provider.ts';

  it('① 重试日志不走 firstTime ? info : debug（那会让观察者为 0）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).not.toContain('const log = firstTime ? logger.info : logger.debug;');
  });

  it('② 固定走 warn（异常路径 + 频率已被下限压住）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('const log = logger.warn.bind(logger);');
  });

  it('③ callClaude 入口有观测点（回答"到底进没进"）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("'callClaude: enter'");
  });

  it('④ 入口观测点是 debug 级（不是每次都刷，只在该开时开）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf("'callClaude: enter'");
    expect(i).toBeGreaterThan(-1);
    const before = s.slice(Math.max(0, i - 200), i);
    expect(before).toContain('logger.debug');
  });

  it('⑤ 原 warn（claude: 空正文）没被改动——它是另一条判据', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('claude: 空正文 —— 思维链吃光 max_tokens（截断）');
  });
});
