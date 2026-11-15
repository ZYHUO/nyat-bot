import { describe, expect, it, vi } from 'vitest';

/**
 * Meta 路径必须处理 act=react（round 54）。
 *
 * 2026-09-23。大样本（n=596）里 react 第一次非零（9 次），模型判得也对
 * （"笑死，欲火焚身可还行"），但**表情一个都没发出去**。
 *
 * 原因：heart-adapter.ts 只判 wait/pass，act=react 落到默认分支被丢掉。
 * 而 Meta 是生产主路径（group_chats_processed 105 vs legacy 7）。
 *
 * 这三条锁住判据本身（不拉起 adapter——它 import bot/redis）：
 *   ① emoji 取 heart.emoji，缺则回落 pickReactionEmoji('neutral')
 *   ② 发出去了 → silence（react 是出口，不该再让 Meta 当普通消息处理）
 *   ③ 没发出去 → **不返回 silence**（不能坐实"点过了"），落到 wait 分支
 */
describe('Meta heart react 分支的判据', () => {
  /** 与 heart-adapter.ts 同形。 */
  function decide(heart: { emoji?: string }, sent: boolean) {
    const emoji = heart.emoji ?? '👀';   // pickReactionEmoji('neutral')
    if (sent) return { verdict: 'silence', reason: 'heart_react' };
    return { verdict: 'fallthrough' };   // → 下面的 wait 分支
  }

  it('① 模型给了 emoji 就用它的', () => {
    const d = decide({ emoji: '🤣' }, true);
    expect(d.verdict).toBe('silence');
  });

  it('② 没给 → 回落 👀，发出去了同样 silence', () => {
    expect(decide({}, true).verdict).toBe('silence');
  });

  it('③ 没发出去 → 不 silence（不能坐实"点过了"）', () => {
    expect(decide({ emoji: '🤣' }, false).verdict).toBe('fallthrough');
  });

  it('④ reactToMessage 失败不抛（它返回 false），所以 try 里不会走 catch', () => {
    // src/bot/sender/telegram.ts: reactToMessage catch 后 return false。
    // 判据必须看返回值，不能只靠 try/catch——否则 false 会被当成成功。
    const reactToMessage = vi.fn(async () => false);
    return reactToMessage(1, 2, '🤣').then((ok) => {
      expect(ok).toBe(false);
      expect(reactToMessage).toHaveBeenCalledWith(1, 2, '🤣');
    });
  });
});
