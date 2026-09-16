// ────────────────────────────────────────
// Turn Actor — 打断后的消息静默期
// ────────────────────────────────────────
//
// MaiBot _wait_for_message_quiet_period 的移植:打断重规划前等用户
// "这一波"消息发完(最近一条入站后 quietMs 内无新消息),否则边打字
// 边重规划会反复作废。有 maxWaitMs 硬上限防饥饿。

import { getLastMsgAt } from './buffer.js';

const POLL_INTERVAL_MS = 150;

export async function waitForMessageQuiet(
  chatId: number,
  quietMs: number,
  maxWaitMs = quietMs * 8,
): Promise<void> {
  if (quietMs <= 0) return;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const lastMsgAt = await getLastMsgAt(chatId);
    if (!lastMsgAt || Date.now() - lastMsgAt >= quietMs) return;
    const remaining = Math.min(
      quietMs - (Date.now() - lastMsgAt),
      deadline - Date.now(),
    );
    await new Promise((r) => setTimeout(r, Math.max(POLL_INTERVAL_MS, Math.min(remaining, 500))));
  }
}
