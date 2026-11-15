// ────────────────────────────────────────
// 语义重复守卫 — "这句话我是不是刚用别的说法说过"
// ────────────────────────────────────────
//
// 2026-09-19 生产事故：一条私聊召唤「猫猫」让 bot 在一个 CodeAct 任务里
// 连发 6 条同义问候（"困到流口水了"→"困到打哈欠了"→"困到要原地融化了"…）。
// 既有的三层守卫全没拦住：
//   1. maxTextSends 上限=6 —— 恰好就是 6，等于没拦
//   2. checkNearDuplicate（字面 bigram Jaccard ≥0.85） —— 同义改写的字面相似度
//      实测只有 0.13~0.27，结构上就抓不到
//   3. isRecentBotEcho —— 只认几乎逐字相同
// 结论：这个失败模式是**语义重复**，不是字面重复，只能用语义判断。
//
// 判断走定型判断基座（src/ai/judge-substrate.ts）——不在这里自己发 HTTP。
// 三条硬约束：
//   - **只在第 2+ 次任务内发送时调用**：正常任务只发 1 条，零成本零延迟。
//   - **fail-open**：基座不可达/无 key → 一律放行。拦截永远不能让基础设施
//     故障吞掉一句话——宁可漏拦，不可误拦。
//   - **不重复花钱**：调用方已先用字面守卫筛过一轮，这里只补语义盲区。

export interface SemanticRepeatResult {
  /** true = 判定为同义重复，调用方应拒绝发送 */
  isRepeat: boolean;
  /** P(同义重复)；null 表示没跑成（fail-open） */
  probability: number | null;
  /** 与哪条历史消息撞上了 */
  collidedWith?: string;
  /** 实际走的后端（chat 兜底时 outer 可观测） */
  backend?: string;
}

/** 不判太短的话：短句/口头禅/纠正补发天然高复现，不算刷屏（与 anti-repeat 一致）。 */
export const MIN_CANDIDATE_CHARS = 8;

/** 没跑成时不拦（fail-open）。 */
const NEVER_BLOCK: SemanticRepeatResult = { isRepeat: false, probability: null };

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 候选句是否与"本任务内已发过的消息"构成同义重复。
 */
export async function checkSemanticRepeat(
  priorInTask: readonly string[],
  candidate: string,
  opts?: { chatId?: number; visibility?: 'private' | 'contextual' | 'public' },
): Promise<SemanticRepeatResult> {
  if (candidate.replace(/\s+/g, '').length < MIN_CANDIDATE_CHARS) return NEVER_BLOCK;
  const priors = priorInTask
    .map(normalize)
    .filter((t) => t.replace(/\s+/g, '').length >= MIN_CANDIDATE_CHARS);
  if (priors.length === 0) return NEVER_BLOCK;

  const recent = priors.slice(-3); // 只跟最近 3 条比：再往前的同义概率低，且都进 state 会稀释判定
  const single = recent.length === 1;
  const state = recent
    .map((p, i) => `${single ? 'bot 上一条已发送' : `bot 已发送#${i + 1}`}：${p}`)
    .join('\n') + `\nbot 准备发送：${normalize(candidate)}`;

  const { judge } = await import('../ai/judge-substrate.js');
  const r = await judge({
    key: 'semantic_repeat',
    state,
    chatId: opts?.chatId,
    visibility: opts?.visibility,
    questions: {
      same: { kind: 'noul', question: '这两条消息是不是同一个意思的重复表达？（同义改写、换种说法讲同一件事都算）' },
    },
  });
  const ans = r.answers.same;
  if (!r.ok || ans === null || ans === undefined) return NEVER_BLOCK;

  const probability = ans.value as number;
  const best = recent[recent.length - 1];
  if (probability < 0.7) return { isRepeat: false, probability, backend: r.backend };
  return {
    isRepeat: true,
    probability,
    ...(best === undefined ? {} : { collidedWith: best }),
    backend: r.backend,
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
