// ────────────────────────────────────────
// Multi-Agent — flag helpers(灰度群判定,与 turn/flags.ts 同款)
// ────────────────────────────────────────
//
// 多智能体依赖 turn-actor 的打断信号(研究员长循环要能被新消息打断),故
// TURN_ACTOR_ENABLED 关时直接不启用,避免研究员 20s 跑满无法打断(L2)。

import { env } from '../../env.js';

/** Is this chat routed through the multi-agent orchestrator (graylist-aware)? */
export function isMultiAgentChat(chatId: number): boolean {
  const e = env();
  if (!e.MULTI_AGENT_ENABLED) return false;
  // L2:multi-agent 需 turn-actor 提供打断;关时不启用,避免研究员无法被新消息打断。
  if (!e.TURN_ACTOR_ENABLED) return false;
  const graylist = e.MULTI_AGENT_CHAT_IDS;
  return graylist.length === 0 || graylist.includes(chatId);
}
