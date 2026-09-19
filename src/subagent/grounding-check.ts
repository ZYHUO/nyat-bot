// ────────────────────────────────────────
// 接地性守卫 — "这个具体数字/事实，聊天里有人提过吗"
// ────────────────────────────────────────
//
// 2026-09-19 05:15 生产事故（群 -1002943259956）：群友白咪城发了一句
// 「（想到瞭不好的東西）」——纯情绪、**没有任何话题**，锚定的还是 1.5 小时前
// 的「她好好看——」（同样没有话题）。bot 回了「2698 换块屏，苹果这刀法确实狠喵」，
// 而这条话题在整个聊天里**从未出现过**（排查见下）。用户：「什么——」，bot 又在
// 下一个任务里复读了一遍「2698换块屏，确实狠」。
//
// 排查（事故后取证，全部为负）：
//   - 本群 Qdrant 全部 441 条历史：零命中「苹果/换块屏/2698」
//   - Qdrant 全库 3000 条：零命中「换块屏/刀法」
//   - 事发前 40 分钟本群 digest：排骨、打卡bot、蹭啃——没有苹果
//   - 发信人白咪城(uid 8358286585)：无任何档案 belief
//   - 本群 scope 的 belief：零条
//   - 当时的图片：梗图 + 「未收到图片」
// 结论：**不是上下文污染，是模型幻觉**——无锚点消息下，模型从参数化知识里
// 抓了一个"适合吐槽的消费话题"（苹果官方换屏价格确实在 2698 元这个量级，
// 所以数字本身是真的，只是跟当前对话毫无关系）。
//
// 签名：**bot 引入一个聊天里没人说过、用户也没问的具体数字/事实**。
// 这与语义重复守卫互补——那个管"同一句话别说两遍"，这个管"别凭空断言"。
//
// 只用 TypeSafe System One (Jev) 一个 Noul，且先用确定性闸门筛掉绝大多数
// 不含具体数字的正常消息，把调用量压到接近零。故障一律 fail-open。

import { env } from '../env.js';

export interface GroundingResult {
  /** true = 判定为无根据的具体断言，调用方应拒绝发送 */
  ungrounded: boolean;
  /** JeV 给出的"这个话题聊天里出现过"的概率；null 表示没跑成（fail-open） */
  topicPresent: number | null;
  /** 用户是否在问这个话题 */
  userAsked: number | null;
}

const NEVER_FLAG: GroundingResult = { ungrounded: false, topicPresent: null, userAsked: null };

/**
 * 确定性闸门：候选消息里有没有"具体数字"（≥3 位连续数字，或 数字+货币单位）。
 * 没有就完全不必问模型——本守卫只针对带具体数字/价格的断言。
 */
export function statesConcreteFact(text: string): boolean {
  return /\d[\d,.]{2,}/.test(text) || /\d+\s*(元|块钱|块|刀|rmb|RMB|¥|\$)/.test(text);
}

async function askJev(state: string, timeoutMs = 3000): Promise<{ topicPresent: number; userAsked: number } | null> {
  const e = env();
  if (!e.TYPESAFE_API_KEY) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(e.TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${e.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state,
        model: e.TYPESAFE_MODEL,
        questions: {
          topic_in_chat: {
            type: 'noul',
            instructions: '这条回复提到的那个事物/话题（以及它对应的数字），在对话记录里出现过吗？',
          },
          user_asked: {
            type: 'noul',
            instructions: '用户（或 bot 被要求回应的那条消息）是在问这个话题吗？',
          },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      answers?: { topic_in_chat?: { noul?: number }; user_asked?: { noul?: number } };
    };
    const t = data.answers?.topic_in_chat?.noul;
    const u = data.answers?.user_asked?.noul;
    if (typeof t !== 'number' || typeof u !== 'number') return null;
    return { topicPresent: t, userAsked: u };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 候选消息是否在"无根据"地断言一个具体事实。
 *
 * @param recentChat 该群最近的对话（user + bot 混合，正序）
 * @param direction  bot 这次被要求回应的话（用户消息）
 */
export async function checkUngroundedClaim(
  candidate: string,
  recentChat: readonly string[],
  direction: string,
): Promise<GroundingResult> {
  // 闸门一：没有具体数字/价格的泛泛吐槽，不可能是"编了个数字"
  if (!statesConcreteFact(candidate)) return NEVER_FLAG;
  const ctx = recentChat.map((t) => t.trim()).filter(Boolean).slice(-15);
  if (ctx.length === 0) return NEVER_FLAG;

  const e = env();
  const state = `对话记录：\n${ctx.join('\n')}\n用户要 bot 回应的消息：${direction.trim() || '（无）'}\nbot 准备回复：${candidate.trim()}`;

  let ans = await askJev(state);
  if (ans === null) ans = await askJev(state, 5000); // 重试一次再放弃
  if (ans === null) return NEVER_FLAG;

  const presentFloor = e.GROUNDING_PRESENT_MAX; // 低于它认为"聊天里没提过"
  const askedFloor = e.GROUNDING_ASKED_MAX; // 低于它认为"用户没在问"
  const ungrounded = ans.topicPresent < presentFloor && ans.userAsked < askedFloor;
  return { ungrounded, topicPresent: ans.topicPresent, userAsked: ans.userAsked };
}

/** 拦截时抛的错误信息——说清"你为什么被拦、该怎么办"。 */
export function ungroundedClaimError(): string {
  return (
    '未发送：你回复里有个具体数字/事实（价格、型号、事件），但最近聊天里没人提过这件事，用户也没在问它。' +
    '不要凭空断言。可以：① 接用户这句话里**真实有的**东西回一句；② 实在不懂就问一句「你说的是啥」。'
  );
}
