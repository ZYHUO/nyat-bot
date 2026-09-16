// ────────────────────────────────────────
// Multi-Agent Router — 分类 chat / lookup(零 LLM,复用 judge.replyPath)
// ────────────────────────────────────────
//
// 速度优先:不额外烧 LLM。judge 已经产出 replyPath(direct/planned):
//   planned(查一下)     → lookup (研究员+记忆员+人设员并行 → 核查员 → 写手;Critic 看开关)
//   direct(闲聊)        → chat   (记忆员+人设员并行 → 写手;CHAT_SPECIALISTS 关则直奔写手)
// (deep 档随 reply tier 系统一并删除。)

import type { ReplyPath } from '../../shared/types.js';

export type AgentRoute = 'chat' | 'lookup';

/** Resolve replyPath into a route. */
export function routeReply(replyPath: ReplyPath | undefined): AgentRoute {
  return replyPath === 'planned' ? 'lookup' : 'chat';
}

/** 路由是否需要进专家(chat 不进)。 */
export function routeNeedsSpecialists(route: AgentRoute): boolean {
  return route === 'lookup';
}
