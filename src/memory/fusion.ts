// ────────────────────────────────────────
// Reciprocal Rank Fusion — 融合向量召回与 BM25 召回
// ────────────────────────────────────────
// 为什么用 RRF 而不是加权分数相加:两路的分值**不可比**。余弦相似度是 [0,1]、
// 分布随模型而变;FTS5 的 bm25 rank 是负数、量纲随语料而变。把它们归一化到同一
// 尺度需要标定,而标定会随语料漂移。RRF 只用**名次**,天然免疫两边的分值分布,
// 这也是它在检索比赛里长期是强基线的原因。
//
//   score(d) = Σ_lists 1 / (k + rank_list(d))     rank 从 1 起
//
// k 起阻尼作用:k 越大,头部名次之间的差距越平。k=60 是原论文的取值,也是通用默认。
// ────────────────────────────────────────

/** RRF 的阻尼常数。 */
export const RRF_K = 60;

/**
 * 按名次融合多路召回。每一路是**已按相关度排好序**的候选数组。
 * `key` 用来跨路识别同一条文档;同一路里重复的 key 只算最靠前那次。
 */
export function rrfFuse<T>(
  lists: Array<T[]>,
  keyOf: (item: T) => string,
  opts: { k?: number; limit?: number } = {},
): T[] {
  const k = opts.k ?? RRF_K;
  const score = new Map<string, number>();
  const first = new Map<string, T>();

  for (const list of lists) {
    const seenInList = new Set<string>();
    let rank = 0;
    for (const item of list) {
      const key = keyOf(item);
      // 同一路内重复:只按最靠前的名次计分,否则重复项会被变相加权。
      if (seenInList.has(key)) continue;
      seenInList.add(key);
      rank++;
      score.set(key, (score.get(key) ?? 0) + 1 / (k + rank));
      // 保留第一次见到的完整对象 —— 向量路带 score/payload,词法路只有 id,
      // 所以把两路按传入顺序排列时,信息更全的那一路应当排在前面。
      if (!first.has(key)) first.set(key, item);
    }
  }

  const fused = [...first.entries()]
    .sort((a, b) => (score.get(b[0]) ?? 0) - (score.get(a[0]) ?? 0))
    .map(([, item]) => item);

  return opts.limit !== undefined ? fused.slice(0, opts.limit) : fused;
}
