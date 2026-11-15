import { describe, expect, it } from 'vitest';
import { findToolPlaceholder } from '../../../src/subagent/host-api.js';

// Host tools return bracketed placeholders when a call cannot be served. They are
// scaffolding for the MODEL to read — never text to send.
//
// Observed 2026-09-18: the bot sent "(invalid chatId)" verbatim into the master's
// DM, because it had called chats.recentMessages with a bad id and echoed the
// result back to the user. The existing sendText guards covered "[object Object]"
// and API-call syntax but not tool results.
//
// Both failure directions matter: a miss leaks internal scaffolding to a user, a
// false positive silently mangles a legitimate message.

describe('tool-result placeholder detection', () => {
  it('catches every placeholder the host tools actually return', () => {
    const real = [
      '(invalid chatId)',
      '(invalid uid)',
      '(context unavailable)',
      '(memory unavailable)',
      '(digest persist disabled)',
      '(empty query)',
      '(empty topic)',
      '(empty)',
      '(no hits)',
      '(pixiv disabled)',
      '(web search disabled)',
      '(linux.sb disabled)',
      '(那个群最近没有记录)',
      '(没有找到相关记录)',
      '(检索失败)',
      '(读取失败)',
      '(谈资库读取失败)',
    ];
    for (const ph of real) expect(findToolPlaceholder(ph), ph).toBeTruthy();
  });

  it('catches a placeholder embedded in a sentence', () => {
    // The model may wrap it in real words rather than sending it bare.
    expect(findToolPlaceholder('我刚查了一下 (invalid chatId)')).toBe('(invalid chatId)');
    expect(findToolPlaceholder('结果： (检索失败)')).toBe('(检索失败)');
  });

  it('catches an unlisted placeholder of the same class', () => {
    // A future tool inventing a new placeholder must not silently leak.
    expect(findToolPlaceholder('(invalid messageId)')).toBeTruthy();
    expect(findToolPlaceholder('(database unavailable)')).toBeTruthy();
    expect(findToolPlaceholder('(no results found)')).toBeTruthy();
  });

  it('does not touch ordinary messages that merely use parentheses', () => {
    const normal = [
      '今天天气不错喵',
      '我查了（真的）没有',
      '他说（大概）会来吧',
      '（笑）你说得对',
      '这个 (括号) 是正常的',
      '喵～在的',
      '在的（刚在忙）',
    ];
    for (const t of normal) expect(findToolPlaceholder(t), t).toBeNull();
  });
});
