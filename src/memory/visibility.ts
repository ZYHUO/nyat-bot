// ────────────────────────────────────────
// 机制1:隐私 visibility 兜底层(借鉴 CyberGroupmate visibility-policy.ts)
// ────────────────────────────────────────
// 打通 DM↔群记忆的前提是"连结但不泄漏":要共享全局画像/跨上下文召回,必须先能在
// **代码层**(不靠 LLM 自觉)兜底,严防 DM 私密内容漏进群、敏感群内容漏进别处。
//
// 两层 visibility:
//   - chat 级:private(DM 且 DM_AUTO_PRIVATE / 命中 MEMORY_SENSITIVE_CHAT_IDS)| shared
//   - 记忆/事实级:'private' | 'contextual' | 'public'
//       private   = 只在原会话/授权时可说
//       contextual= 只在来源会话/同上下文可说(群里聊的默认这级)
//       public    = 可跨上下文引用
//
// 不变式(boundChatId = 当前回复所在会话):
//   R1 读隔离:跨上下文读到 visibility==='private',或来源会话是私密会话且 ≠ boundChatId
//              → 逐条 scrub 丢弃。
//   （xxb-ts 无 sandbox,scrub 收口在"记忆检索返回"与"画像注入 prompt"两处。）

import { env } from '../env.js';
import { isDM } from '../shared/chat.js';

export type ChatVisibility = 'private' | 'shared';
export type MemoryVisibility = 'private' | 'contextual' | 'public';

/** 某会话的 chat 级私密性。DM 默认私密(DM_AUTO_PRIVATE),或命中敏感会话种子。 */
export function getChatVisibility(chatId: number | null | undefined): ChatVisibility {
  if (chatId === null || chatId === undefined) return 'shared';
  const e = env();
  if (e.MEMORY_SENSITIVE_CHAT_IDS.includes(chatId)) return 'private';
  if (e.DM_AUTO_PRIVATE && isDM(chatId)) return 'private';
  return 'shared';
}

export function isPrivateChat(chatId: number | null | undefined): boolean {
  return getChatVisibility(chatId) === 'private';
}

/** 写入某会话的记忆时,该条默认的记忆级 visibility(DM/敏感→private,群→contextual)。 */
export function defaultVisibilityForChat(chatId: number): MemoryVisibility {
  return isPrivateChat(chatId) ? 'private' : 'contextual';
}

/** 一条可做可见性判定的记忆/事实的最小形态。 */
export interface VisibilityFields {
  visibility?: MemoryVisibility;
  /** 记忆来源会话(写入时的 chatId)。 */
  sourceChatId?: number | null;
}

/**
 * R1 核心判定:这条记忆在 boundChatId 上下文里,是否属于"跨界私密"需被 scrub。
 * 双判(对齐 CGM reflection.ts:1305 "来源群私密性兜底"):
 *   - 本会话(sourceChatId === boundChatId)的记忆始终保留;
 *   - visibility==='private' → 跨界即丢;
 *   - 来源会话本身是私密会话(DM/敏感群)→ 跨界即丢(即便该条只标了 contextual);
 *   - 缺 visibility 字段(存量数据)→ 退回按来源会话私密性判定(宁严勿松)。
 * 默认尺度:public + 来自 shared 群的 contextual 允许跨上下文带出;private 一律剔除。
 */
export function isCrossContextPrivate(
  item: VisibilityFields,
  boundChatId: number,
): boolean {
  const src = item.sourceChatId ?? null;
  if (src !== null && src === boundChatId) return false; // 本会话恒保留
  if (item.visibility === 'private') return true;
  if (item.visibility === 'public') return false;
  // contextual 或缺失 → 看来源会话私密性(缺 src 时无法判定来源,保守视作可跨界的
  // contextual;调用方对存量无 src 的数据应尽量补 sourceChatId)。
  return isPrivateChat(src);
}

export interface ScrubResult<T> {
  kept: T[];
  dropped: number;
}

/**
 * 逐条 scrub 一批记忆命中(机制4 跨上下文召回返回前调用)。
 * visibility 关时原样返回(默认检索仍锁 chatId,天然安全,不受影响)。
 */
export function scrubMemoryHits<T extends VisibilityFields>(
  hits: readonly T[],
  boundChatId: number,
): ScrubResult<T> {
  if (!env().MEMORY_VISIBILITY_ENABLED || !Array.isArray(hits)) {
    return { kept: (hits ?? []) as T[], dropped: 0 };
  }
  const kept: T[] = [];
  let dropped = 0;
  for (const h of hits) {
    if (isCrossContextPrivate(h, boundChatId)) dropped++;
    else kept.push(h);
  }
  return { kept, dropped };
}

/**
 * 画像文本按来源上下文 scrub(机制3 全局画像注入 prompt 前调用)。
 * 全局画像的每个片段带 sourceChatId;注入进 boundChatId 时,来自私密会话且 ≠ 本会话的
 * 片段被剔除。visibility 关时原样返回。
 */
export interface ProfileFragment extends VisibilityFields {
  text: string;
}

export function scrubProfileFragments(
  fragments: readonly ProfileFragment[],
  boundChatId: number,
): ProfileFragment[] {
  if (!env().MEMORY_VISIBILITY_ENABLED || !Array.isArray(fragments)) {
    return (fragments ?? []) as ProfileFragment[];
  }
  return fragments.filter((f) => !isCrossContextPrivate(f, boundChatId));
}
