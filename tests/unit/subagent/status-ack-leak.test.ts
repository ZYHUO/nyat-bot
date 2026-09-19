import { describe, expect, it } from 'vitest';
import { findInternalStatusAck } from '../../../src/subagent/host-api.js';

// 2026-09-19 05:22 production incident (group -1002943259956): after a normal
// reply the bot sent a second bubble reading 「（已回复 #3193）」. The string does
// not exist anywhere in the source tree — it came from the MODEL confusing its
// endTask bookkeeping format ("已回复 @谁 #id，做了什么" — 1104 such digests in
// production) with the channel a user actually reads.
//
// This guard is deliberately narrow: only a message that IS a status ack and
// nothing more. Both failure directions matter — missing the family leaks
// bookkeeping, over-matching mangles legitimate banter like 「已读不回是吗」.

describe('findInternalStatusAck', () => {
  it('catches the exact string from the incident', () => {
    expect(findInternalStatusAck('（已回复 #3193）')).toBe('（已回复 #3193）');
  });

  it('catches the same bookkeeping in other wrappings', () => {
    for (const t of [
      '(已回复 #3193)',
      '已回复 #3193',
      '已回复 3193',
      '（已回复 3193）',
      '（已回复#3193）',
      '（已回复 #3193，',
      '（已读 #88）',
      '（已发送 #1024）',
      '(已转达 #77)',
      '（已送到 #5）',
    ]) {
      expect(findInternalStatusAck(t), t).toBeTruthy();
    }
  });

  it('leaves ordinary messages that merely start with those words alone', () => {
    // No message id → it is a person talking, not a bookkeeping line.
    for (const t of [
      '已读不回是吧',
      '已读，然后呢',
      '我看到了喵',
      '已发送给您了喵',
      '回复你了没看见吗',
      '（笑）你说得对',
      '这个 (括号) 是正常的',
      '在的（刚在忙）',
      '今天天气不错喵',
      '已回复你三遍了还问',
      '我发了但是没回音',
    ]) {
      expect(findInternalStatusAck(t), t).toBeNull();
    }
  });

  it('ignores long messages — a real sentence that merely cites an id', () => {
    const real =
      '我刚才已经回复过你 #3193 那条了，你说要冲冷水消毒，我说了对吧，别再问我一遍了喵';
    expect(findInternalStatusAck(real)).toBeNull();
  });

  it('only fires on bare status words, not on sentences containing them', () => {
    expect(findInternalStatusAck('（已回复 #3193）but actually 我还有话要说')).toBeNull();
  });
});
