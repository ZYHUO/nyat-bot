// ────────────────────────────────────────
// Meta 路径的 bot 消息两道闸
// ────────────────────────────────────────
//
// 为什么单独一个文件：这两道闸原来内联在 message.ts 的 finishMeta 闭包里，
// 而那个闭包埋在 handler 深处，**没有任何单测能碰到它**。round 1 修的
// "验证 bot 被回复 6 次"就是这个缺口的结果——分类降噪在 Meta 主路径上
// 从未生效，而测试全绿，因为没人测那条路。
//
// 抽出来之后：逻辑单一来源、可单测、message.ts 只负责接线。

import { isMentioningSelf } from '../../pipeline/judge/rules.js';
import type { FormattedMessage } from '../../shared/types.js';

export type BotGateVerdict =
  /** 结构闸：没 @ 我、也不是回复我 → 0ms 忽略，不烧心流 */
  | 'ignore-structural'
  /** 语义闸：叫了我，但属于非对话型 bot（ad/verify/echo）→ 降噪 */
  | 'denoise-semantic'
  /** 放行：交给心流 */
  | 'pass';

export interface BotIdentity {
  uid: number;
  username: string;
  nicknames: string[];
}

export interface BotGateFlags {
  classifierEnabled: boolean;
  denoiseEnabled: boolean;
}

/** 分类器认出的"非对话型 bot"三类。 */
const NON_CONVERSATIONAL = new Set(['ad', 'verify', 'echo']);

/**
 * 别的 bot 发来一条消息，Meta 路径该怎么处理。
 *
 * 两道闸，**顺序不能换**：
 *
 *   1. 结构（0ms，无 LLM）—— 没 @ 我、也不是回复我 → 忽略。
 *      这一道 legacy 的 L0 `bot_message` 规则一直有，Meta 路径此前没有。
 *      它覆盖"所有没叫我的 bot"，包括分类器认不出来的那类。
 *   2. 语义（分类器）—— 叫了我，但属于 ad/verify/echo → 降噪。
 *      它覆盖"叫了我的非对话型 bot"。
 *
 * 少任何一道都漏一类：
 *   只有语义 → 分类器漏认的 bot 会烧心流（round 1 的 6 次回复正是这类）
 *   只有结构 → 叫了我的广告 bot 照样拿到心流判定
 */
export function decideBotMessage(
  fm: FormattedMessage,
  identity: BotIdentity,
  classify: (m: FormattedMessage) => string,
  flags: BotGateFlags,
): BotGateVerdict {
  const text = fm.textContent || fm.captionContent || '';
  const mentionsMe = isMentioningSelf(text, identity.username, identity.nicknames);
  const repliesToMe = fm.replyTo?.uid === identity.uid;

  // 闸 1：结构。放在分类器之前——它更便宜也更宽。
  if (!mentionsMe && !repliesToMe) return 'ignore-structural';

  // 闸 2：语义。
  if (!flags.classifierEnabled) return 'pass';
  const cls = classify(fm);
  if (cls !== 'unknown' && cls !== 'self' && flags.denoiseEnabled && NON_CONVERSATIONAL.has(cls)) {
    return 'denoise-semantic';
  }
  return 'pass';
}
