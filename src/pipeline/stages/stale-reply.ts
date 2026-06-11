// ────────────────────────────────────────
// Pipeline stage: stale-reply suppression + deferred typo fix
// (extracted from pipeline.ts)
// ────────────────────────────────────────

import { getRecent } from "../context/manager.js";
import { editMessage } from "../../bot/sender/telegram.js";
import { DIRECT_INTERACTION_RULES } from "../shared.js";
import { logger } from "../../shared/logger.js";

/**
 * #9 分钟级延迟改错字:真人常常过几分钟才想起来 edit 一个 typo。
 * 进程内定时器(重启丢失可接受);触发时若中间有人说过话 → "被打断忘了改"。
 */
export function scheduleDeferredTypoFix(chatId: number, messageId: number, correctText: string, sentAtSec: number): void {
  const delayMs = (120 + Math.random() * 360) * 1000; // 2–8 分钟
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const recent = await getRecent(chatId, 6);
        const interrupted = recent.some((m) => m.role !== "assistant" && m.timestamp > sentAtSec);
        if (interrupted) return; // 有人说话了,忘了改
        await editMessage(chatId, messageId, correctText);
        logger.debug({ chatId, messageId }, "Deferred typo fix applied");
      } catch { /* non-critical */ }
    })();
  }, delayMs);
  timer.unref?.();
}

function isAssistantTurn(
  message: { role: string; uid: number },
  botUid: number,
): boolean {
  return message.role === "assistant" || message.uid === botUid;
}

export async function shouldSuppressStaleReply(
  chatId: number,
  message: { messageId: number; uid: number },
  judgeRule: string | undefined,
  botUid: number,
  recentWindow: number,
): Promise<boolean> {
  if (chatId > 0 || (judgeRule && DIRECT_INTERACTION_RULES.has(judgeRule))) {
    return false;
  }

  const recent = await getRecent(chatId, Math.max(recentWindow, 20));
  const currentIndex = recent.findIndex(
    (entry) =>
      entry.messageId === message.messageId && entry.uid === message.uid,
  );
  if (currentIndex < 0) return false;

  return recent
    .slice(currentIndex + 1)
    .some((entry) => isAssistantTurn(entry, botUid));
}
