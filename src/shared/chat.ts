// ────────────────────────────────────────
// Chat-kind helpers（消除全库裸 `chatId > 0 / < 0` 约定）
// ────────────────────────────────────────
// Telegram 约定:私聊(DM)chatId 为正,群/超级群 chatId 为负。
// 新代码一律用这两个 helper 表达意图,旧的裸比较不强制重构。

/** 私聊(DM):Telegram 私聊 chatId 恒为正。 */
export function isDM(chatId: number): boolean {
  return chatId > 0;
}

/** 群聊(group / supergroup):Telegram 群 chatId 恒为负。 */
export function isGroup(chatId: number): boolean {
  return chatId < 0;
}
