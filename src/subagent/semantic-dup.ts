// ────────────────────────────────────────
// 语义重复守卫 — "这句话我是不是刚用别的说法说过"
// ────────────────────────────────────────
//
// 背景（2026-09-19 生产事故）：一条私聊召唤「猫猫」让 bot 在一个 CodeAct 任务里
// 连发 6 条同义问候（"困到流口水了"→"困到打哈欠了"→"困到要原地融化了"…）。
// 既有的三层守卫全没拦住：
//   1. maxTextSends 上限=6 —— 恰好就是 6，等于没拦
//   2. checkNearDuplicate（字面 bigram Jaccard ≥0.85） —— 同义改写的字面相似度
//      实测只有 0.13~0.27，结构上就抓不到
//   3. isRecentBotEcho —— 只认几乎逐字相同
// 结论：这个失败模式是**语义重复**，不是字面重复，只能用语义判断。
//
// 用 TypeSafe System One（Jev）的 Noul：问一句"这两条消息是不是同一个意思的重复
// 表达"。选它而不是把两段文本塞给回复大模型，是因为这里需要的是一个小而快的
// is-it-a-repeat 判定，code 拥有流程、模型只提供那一点语义常识。
//
// 校准（36 对人工标注的真实生产配对，见 tests/unit/subagent/semantic-dup.test.ts
// 记录的分布）：REPEAT p=0.55~0.97（中心 0.84），DIFF p=0.07~0.72（均值 0.27）。
// 同义改写恰恰落在字面守卫的盲区（Jaccard 0.11~0.12 → JeV p=0.55~0.87）。
//
// 三条硬约束：
//   - **只在第 2+ 次任务内发送时调用**：正常任务只发 1 条，零成本零延迟。
//   - **fail-open**：JeV 不可达/超时/解析失败 → 一律放行。拦截永远不能让基础设施
//     故障吞掉一句话——宁可漏拦，不可误拦。
//   - **不重复花钱**：调用方已先用字面守卫筛过一轮，这里只补语义盲区。

import { env } from '../env.js';

export interface SemanticRepeatResult {
  /** true = 判定为同义重复，调用方应拒绝发送 */
  isRepeat: boolean;
  /** JeV 给出的"是同义重复"概率；null 表示没跑成（fail-open） */
  probability: number | null;
  /** 与哪条历史消息撞上了 */
  collidedWith?: string;
}

/** 不判太短的话：短句/口头禅/纠正补发天然高复现，不算刷屏（与 anti-repeat 一致）。 */
export const MIN_CANDIDATE_CHARS = 8;

/** 没跑成时不拦（fail-open）。 */
const NEVER_BLOCK: SemanticRepeatResult = { isRepeat: false, probability: null };

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 调 TypeSafe System One 问一个 Noul。返回 null = 没问成（网络错/超时/字段缺失）。
 * 超时默认 3s：这是发送前的同步检查，不能让用户干等一个语义判定。
 */
async function askJev(state: string, timeoutMs = 3000): Promise<number | null> {
  const e = env();
  const apiKey = e.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(e.TYPESAFE_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state,
        model: e.TYPESAFE_MODEL,
        questions: {
          same: {
            type: 'noul',
            instructions:
              '这两条消息是不是同一个意思的重复表达？（同义改写、换种说法讲同一件事都算重复）',
          },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      answers?: { same?: { noul?: number } };
    };
    const p = data.answers?.same?.noul;
    return typeof p === 'number' && Number.isFinite(p) ? p : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 候选句是否与"本任务内已发过的消息"构成同义重复。
 *
 * @param priorInTask 本任务此前发过的正文（按时间正序；只取最近的若干条，省 token）
 * @param minGapSec   距 task 开始/距上一条发送的最小间隔要求由调用方把关；这里只负责语义
 */
export async function checkSemanticRepeat(
  priorInTask: readonly string[],
  candidate: string,
): Promise<SemanticRepeatResult> {
  // 短句/空句不判：口头禅和纠正补发天然相似，判了会误伤。
  if (candidate.replace(/\s+/g, '').length < MIN_CANDIDATE_CHARS) return NEVER_BLOCK;
  const priors = priorInTask.map(normalize).filter((t) => t.replace(/\s+/g, '').length >= MIN_CANDIDATE_CHARS);
  if (priors.length === 0) return NEVER_BLOCK;

  const e = env();
  const threshold = e.SEMANTIC_DUP_THRESHOLD;
  // 只跟最近 3 条比：再往前的同义概率低，且每条都进 state 会稀释判定。
  const recent = priors.slice(-3);
  const state = recent.map((p, i) => `${recent.length === 1 ? 'bot 上一条已发送' : `bot 已发送#${i + 1}`}：${p}`).join('\n') + `\nbot 准备发送：${normalize(candidate)}`;

  let probability = await askJev(state);
  if (probability === null) {
    // 3 秒超时/网络抖动不值得整条消息改道，但值得再给一次机会：降阈值重问一次。
    probability = await askJev(state, 5000);
  }
  if (probability === null) return NEVER_BLOCK;

  if (probability < threshold) return { isRepeat: false, probability };
  // 撞上的是概率最高的那条（不逐条调，省调用；撞谁不重要，拦住才重要）。
  const best = recent[recent.length - 1];
  return {
    isRepeat: true,
    probability,
    ...(best === undefined ? {} : { collidedWith: best }),
  };
}

/** 拦截时抛的错误信息——会原样出现在模型的 [observation:error] 里，要说人话、可行动。 */
export function semanticRepeatError(result: SemanticRepeatResult): string {
  const pct = result.probability === null ? '?' : String(Math.round(result.probability * 100));
  return (
    `重复表达未发送：这句话和你上面刚说过的意思一样（${pct}% 判定重复），` +
    '同一个意思只说一遍。如果你要补充的是**新**信息，就写新内容再发；' +
    '没有新东西就直接 runtime.endTask 收尾。'
  );
}
