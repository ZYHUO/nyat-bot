// ────────────────────────────────────────
// 接地性守卫 — "这个具体数字/事实，聊天里有人提过吗"
// ────────────────────────────────────────
//
// 2026-09-19 05:15 生产事故（群 -1002943259956）：群友白咪城发了一句
// 「（想到瞭不好的東西）」——纯情绪、**没有任何话题**，锚定的还是 1.5 小时前
// 的「她好好看——」（同样没有话题）。bot 回了「2698 换块屏，苹果这刀法确实狠喵」，
// 而这条话题在整个聊天里**从未出现过**（排查：本群 441 条 Qdrant 历史零命中、
// 全库 3000 条零命中、事发前 40min digest 只有排骨和打卡bot、发信人无档案、
// 无本群 belief、当时图片是梗图）。用户：「什么——」，bot 又在下一个任务里复读了一遍。
//
// 签名：**bot 引入一个聊天里没人说过、用户也没问的具体数字/事实**。
// 数字本身是真的（苹果官方换屏确实在 2698 量级），所以这句话听起来底气十足——
// 这才是它危险的地方。
//
// 判断走定型判断基座，一次调用问两个问题（speculative fan-out）。
// 与语义重复守卫互补：那个管"同一句话别说两遍"，这个管"别凭空断言"。

import { env } from '../env.js';

export interface GroundingResult {
  ungrounded: boolean;
  topicPresent: number | null;
  userAsked: number | null;
  backend?: string;
}

const NEVER_FLAG: GroundingResult = { ungrounded: false, topicPresent: null, userAsked: null };

/**
 * 确定性闸门：候选消息里有没有"具体数字"（≥3 位连续数字，或 数字+货币单位）。
 * 没有就完全不必问模型——本守卫只针对带具体数字/价格的断言。
 */
export function statesConcreteFact(text: string): boolean {
  return /\d[\d,.]{2,}/.test(text) || /\d+\s*(元|块钱|块|刀|rmb|RMB|¥|\$)/.test(text);
}

export async function checkUngroundedClaim(
  candidate: string,
  recentChat: readonly string[],
  direction: string,
  opts?: { chatId?: number; visibility?: 'private' | 'contextual' | 'public' },
): Promise<GroundingResult> {
  if (!statesConcreteFact(candidate)) return NEVER_FLAG;
  const ctx = recentChat.map((t) => t.trim()).filter(Boolean).slice(-15);
  if (ctx.length === 0) return NEVER_FLAG;

  const state =
    `对话记录：\n${ctx.join('\n')}\n` +
    `用户要 bot 回应的消息：${direction.trim() || '（无）'}\n` +
    `bot 准备回复：${candidate.trim()}`;

  const { judge } = await import('../ai/judge-substrate.js');
  const r = await judge({
    key: 'grounding_claim',
    state,
    chatId: opts?.chatId,
    visibility: opts?.visibility,
    questions: {
      topic_in_chat: {
        kind: 'noul',
        question: '这条回复提到的那个事物/话题（以及它对应的数字），在对话记录里出现过吗？',
      },
      user_asked: {
        kind: 'noul',
        question: '用户（或 bot 被要求回应的那条消息）是在问这个话题吗？',
      },
    },
  });
  const tp = r.answers.topic_in_chat;
  const ua = r.answers.user_asked;
  if (!r.ok || tp === null || tp === undefined || ua === null || ua === undefined) return NEVER_FLAG;

  // 阈值从 env 读，不再硬编码 0.35。
  //
  // 2026-09-21：GROUNDING_PRESENT_MAX / GROUNDING_ASKED_MAX 两个旗标声明了、
  // .env 里也配了（都是 0.35），而全仓库没有一处读它们——这里是个写死的 0.35。
  // 值和 .env 恰好一样，所以接上不改变行为，只是让它们真的可调。
  // 跟 GOAL_LONG_TERM_ENABLED 同一类：旗标的用途是真的，被常量绕过了。
  let presentMax = 0.35;
  let askedMax = 0.35;
  try {
    presentMax = Math.max(0, Math.min(1, Number(env().GROUNDING_PRESENT_MAX ?? 0.35)));
    askedMax = Math.max(0, Math.min(1, Number(env().GROUNDING_ASKED_MAX ?? 0.35)));
  } catch {
    /* env 不可用时退回 0.35 —— 与改动前一致 */
  }
  const ungrounded = (tp.value as number) < presentMax && (ua.value as number) < askedMax;
  return {
    ungrounded,
    topicPresent: tp.value as number,
    userAsked: ua.value as number,
    backend: r.backend,
  };
}

/** 拦截时抛的错误信息——说清"你为什么被拦、该怎么办"。 */
export function ungroundedClaimError(): string {
  return (
    '未发送：你回复里有个具体数字/事实（价格、型号、事件），但最近聊天里没人提过这件事，用户也没在问它。' +
    '不要凭空断言。可以：① 接用户这句话里**真实有的**东西回一句；② 实在不懂就问一句「你说的是啥」。'
  );
}
