/**
 * Meta 路径 bot 消息的两道闸。
 *
 * 这两个测试的存在理由：这两道闸原来内联在 message.ts 的 finishMeta 闭包里，
 * **没有任何单测能碰到它**。round 1 修的"验证 bot 被回复 6 次"就是那个缺口的
 * 结果——分类降噪在 Meta 主路径上从未生效，而测试全绿。
 *
 * 锁四件事：
 *   ① 没 @ 我、不是回复我 → 结构性忽略（0ms，不烧心流）—— 这一道 Meta 路径
 *      原本没有，legacy 的 L0 一直有
 *   ② 叫了我 + 非对话型 bot → 语义降噪
 *   ③ 叫了我 + 普通 bot → 放行（bot 之间可以对话）
 *   ④ 分类器关 → 只有结构闸在工作
 */
import { describe, it, expect, vi } from 'vitest';
import type { FormattedMessage } from '../../../../src/shared/types.js';

vi.mock('../../../../src/pipeline/judge/rules.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../../src/pipeline/judge/rules.js')>();
  return { ...orig };
});

const { decideBotMessage } = await import('../../../../src/bot/handlers/meta-bot-gate.js');

const ID = { uid: 999, username: 'hunhebi_bot', nicknames: ['啾咪囝', '本喵'] };

function botMsg(over: Partial<FormattedMessage> = {}): FormattedMessage {
  return {
    role: 'user',
    uid: 5304501737,
    username: 'nmnmfunbot',
    fullName: 'nmBot',
    messageId: 1,
    timestamp: 0,
    isForwarded: false,
    isBot: true,
    textContent: 'Tiara Agar has passed the group verification.',
    ...over,
  } as FormattedMessage;
}

/**
 * 分类器 stub：按文本关键字返回类别。
 * 取 text ?? caption —— 和真分类器（bot-classifier.ts:46）同口径，
 * 否则 caption 用例会假失败（第一版就栽在这：stub 只看 textContent，
 * 而代码已经正确地把 caption 纳入判据）。
 */
function classifier(map: Record<string, string>) {
  return (m: FormattedMessage): string => {
    const t = m.textContent || m.captionContent || '';
    for (const [k, v] of Object.entries(map)) if (t.includes(k)) return v;
    return 'unknown';
  };
}

const BOTH_ON = { classifierEnabled: true, denoiseEnabled: true };

describe('decideBotMessage · 结构闸（第一道）', () => {
  it('① 别的 bot 没 @ 我、也不是回复我 → 结构性忽略', () => {
    expect(decideBotMessage(botMsg(), ID, classifier({}), BOTH_ON)).toBe('ignore-structural');
  });

  it('①b nmbot 的验证消息（最常见）→ 结构性忽略，不烧心流', () => {
    const v = decideBotMessage(
      botMsg({ textContent: 'Jeffrey Thompson has passed the group verification.' }),
      ID, classifier({ verify: 'verify' }), BOTH_ON,
    );
    expect(v).toBe('ignore-structural');
  });

  it('①c 分类器关掉也照样结构性忽略（这道不依赖分类器）', () => {
    expect(decideBotMessage(botMsg(), ID, classifier({}), { classifierEnabled: false, denoiseEnabled: false }))
      .toBe('ignore-structural');
  });
});

describe('decideBotMessage · 语义闸（第二道）', () => {
  it('② 叫了我 + 分类为 ad/verify/echo → 降噪', () => {
    for (const cls of ['ad', 'verify', 'echo']) {
      const v = decideBotMessage(
        botMsg({ textContent: '@hunhebi_bot 看看这个' }),
        ID, classifier({ '@hunhebi_bot': cls }), BOTH_ON,
      );
      expect(v, cls).toBe('denoise-semantic');
    }
  });

  it('②b 回复我也算"叫了我"', () => {
    const v = decideBotMessage(
      botMsg({ textContent: '嗯', replyTo: { uid: 999, messageId: 5 } }),
      ID, classifier({ '嗯': 'ad' }), BOTH_ON,
    );
    expect(v).toBe('denoise-semantic');
  });

  it('③ 叫了我 + 普通 bot（unknown/chat/cmd_result）→ 放行', () => {
    for (const cls of ['unknown', 'chat', 'cmd_result']) {
      const v = decideBotMessage(
        botMsg({ textContent: '@hunhebi_bot 在吗' }),
        ID, classifier({ '@hunhebi_bot': cls }), BOTH_ON,
      );
      expect(v, cls).toBe('pass');
    }
  });

  it('④ 分类器关 → 没有语义闸，只有结构闸（叫了我就放行）', () => {
    const v = decideBotMessage(
      botMsg({ textContent: '@hunhebi_bot 看看这个' }),
      ID, classifier({ '@hunhebi_bot': 'ad' }), { classifierEnabled: false, denoiseEnabled: true },
    );
    expect(v).toBe('pass');
  });

  it('④b 降噪关 → 分类出来也不降噪（叫了我就放行）', () => {
    const v = decideBotMessage(
      botMsg({ textContent: '@hunhebi_bot 看看这个' }),
      ID, classifier({ '@hunhebi_bot': 'ad' }), { classifierEnabled: true, denoiseEnabled: false },
    );
    expect(v).toBe('pass');
  });
});

describe('decideBotMessage · 顺序（结构必须先于语义）', () => {
  it('没叫我的 bot 即使分类成 ad 也走结构闸（更便宜的那道先拦）', () => {
    const calls: string[] = [];
    const spy = (m: FormattedMessage): string => {
      calls.push(m.textContent ?? '');
      return 'ad';
    };
    const v = decideBotMessage(botMsg(), ID, spy, BOTH_ON);
    expect(v).toBe('ignore-structural');
    // 结构闸命中时**不该调用分类器**——否则"0ms"是假的
    expect(calls).toEqual([]);
  });

  it('叫了我的 bot 才会走到分类器', () => {
    const calls: string[] = [];
    const spy = (m: FormattedMessage): string => {
      calls.push(m.textContent ?? '');
      return 'chat';
    };
    decideBotMessage(botMsg({ textContent: '@hunhebi_bot 早' }), ID, spy, BOTH_ON);
    expect(calls.length).toBe(1);
  });
});

describe('decideBotMessage · 边界', () => {
  it('空文本的 bot 消息 → 结构性忽略（不猜）', () => {
    expect(decideBotMessage(botMsg({ textContent: '' }), ID, classifier({}), BOTH_ON)).toBe('ignore-structural');
  });

  it('caption 也算文本（bot 常发带 caption 的媒体）', () => {
    const v = decideBotMessage(
      botMsg({ textContent: '', captionContent: '@hunhebi_bot 看图' }),
      ID, classifier({ '@hunhebi_bot': 'ad' }), BOTH_ON,
    );
    expect(v).toBe('denoise-semantic');
  });

  it('叫昵称也算叫了我', () => {
    const v = decideBotMessage(botMsg({ textContent: '本喵 帮个忙' }), ID, classifier({ '本喵': 'ad' }), BOTH_ON);
    expect(v).toBe('denoise-semantic');
  });
});
