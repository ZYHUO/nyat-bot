// ────────────────────────────────────────
// Telegram 允许的 reaction emoji 白名单(纯模块,parser 可安全引用)
// ────────────────────────────────────────
//
// Telegram setMessageReaction 只接受固定集合;注意 ❤ 是 U+2764(不带
// U+FE0F 变体选择符)。parser 校验模型选的 emoji,非法时丢弃该 react
// 元素(发错情绪的 emoji 比不发更糟)。

export const ALLOWED_REACTION_EMOJI = new Set([
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱',
  '🤬', '😢', '🎉', '🤩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴',
  '😍', '🤣', '💯', '⚡', '🍌', '🏆', '💔', '😈', '😴', '😭',
  '👀', '🎃', '🙈', '😇', '🤝', '🫡', '🤗', '🆒', '🗿', '🤨',
]);

/** Normalize a model-emitted reaction emoji to Telegram's allowed set, or null. */
export function normalizeReactionEmoji(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Strip variation selectors (U+FE0F) — Telegram wants bare codepoints.
  const stripped = raw.trim().replace(/️/g, '');
  if (ALLOWED_REACTION_EMOJI.has(stripped)) return stripped;
  return null;
}
