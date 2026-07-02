// ────────────────────────────────────────
// Multi-Agent Router — 分类 chat / lookup / deep(零 LLM,复用 judge.replyPath+tier)
// ────────────────────────────────────────
//
// 速度优先:不额外烧 LLM。judge 已经产出 replyPath(direct/planned)+ replyTier:
//   max 档(深度)        → deep   (研究员+记忆员+人设员并行 → 核查员 → 写手 → Critic)
//   planned(查一下)     → lookup (研究员+记忆员+人设员并行 → 核查员 → 写手;Critic 看开关)
//   direct(闲聊)        → chat   (记忆员+人设员并行 → 写手;CHAT_SPECIALISTS 关则直奔写手)
// 后续要更细的 lookup/deep 分级可在此加轻量 LLM,但只在 planned 路径付费。

import type { ReplyPath, ReplyTier } from '../../shared/types.js';

export type AgentRoute = 'chat' | 'lookup' | 'deep';

/** Resolve replyPath + replyTier into a route. */
export function routeReply(replyPath: ReplyPath | undefined, replyTier?: ReplyTier): AgentRoute {
  if (replyTier === 'max') return 'deep';
  return replyPath === 'planned' ? 'lookup' : 'chat';
}

/** 路由是否需要进专家(chat 不进)。 */
export function routeNeedsSpecialists(route: AgentRoute): boolean {
  return route === 'lookup' || route === 'deep';
}

/** 路由是否是 deep(跑核查员 + Critic)。 */
export function routeIsDeep(route: AgentRoute): boolean {
  return route === 'deep';
}
