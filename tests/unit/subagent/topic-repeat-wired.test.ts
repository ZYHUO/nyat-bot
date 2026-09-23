import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 话题词复用闸必须真的接在发送路径上（round 162）。
 *
 * 用户 2026-09-23 21:51 报的 bug：30 秒 7 个气泡里"固定资产"出现 3 次。
 * 纯函数的 10 条测试（topic-repeat.test.ts）证明判据对，但**判据对不等于
 * 接上了**——这个仓反复出现的形态（round 54/57/80：功能只接在 legacy 上）。
 */
describe('话题词复用闸接在发送路径上', () => {
  const SRC = 'src/subagent/host-api.ts';

  it('① host-api 调用了 findTopicRepeat（不是只 import 了）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const codeLines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(codeLines.some((l) => l.includes('findTopicRepeat('))).toBe(true);
    expect(s).toContain("from './topic-repeat.js'");
  });

  // round 141/142 的教训：单行断言抓不到跨行的模板字符串。这里取
  // findTopicRepeat 调用点之后 25 行的整块来断言。
  const guardBlock = (): string => {
    const s = fs.readFileSync(SRC, 'utf8');
    const codeLines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    const idx = codeLines.findIndex((l) => l.includes('findTopicRepeat('));
    expect(idx).toBeGreaterThan(-1);
    return codeLines.slice(idx, idx + 25).join('\n');
  };

  it('② 拦下来时抛错给模型看（不是静默丢弃）', () => {
    const block = guardBlock();
    expect(block).toContain('throw new Error');
    expect(block).toContain('未发送');
    expect(block).toContain('换个说法');
  });

  it('③ 有计数器 + info 日志（round 75 家族：拦住必须可见）', () => {
    const block = guardBlock();
    expect(block).toContain("incrCounter('send_topic_word_repeat_total'");
    expect(block).toContain('logger.info');
    expect(block).toContain('host sendText rejected topic-word repeat');
  });

  it('④ 读的是本群最近的发送史（recentBotTextsByChat，跨任务共享）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const codeLines = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(codeLines.some((l) => l.includes('recentBotTextsByChat.get(chatId)'))).toBe(true);
  });

  it('⑤ 该闸在 isRecentBotEcho 之前（整句闸先跑还是词闸先跑无所谓，但不能在发送后）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const topicIdx = s.indexOf('findTopicRepeat(');
    const sendIdx = s.indexOf('const messageId = await sendMessage(');
    expect(topicIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(-1);
    expect(topicIdx).toBeLessThan(sendIdx);
  });
});
