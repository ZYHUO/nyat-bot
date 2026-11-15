// round 162：**话题词复用闸**（用户 2026-09-23 21:51 现场报的 bug）。
//
// 现场：30 秒内 7 个气泡，其中
//   「算固定资产改良」「窗台固定资产台账更新……」「窗台也要入固定资产台账……」
// "固定资产"出现 3 次、"台账"2 次。人眼一看就是重复回复。
//
// 而仓里已有的去重全是**整句相同**这一族：
//   · `isEchoOf`（echo-text.ts）归一化后相等 / 包含 ≥0.72 / bigram 重叠 ≥0.72
//   · `dedupKey`（telegram.ts）同群同文本前 4 字 + 30s TTL
//   · `checkSemanticRepeat`（semantic-dup.ts）整句语义相似度
// 这三个都抓不到"**同一个词，换着句子说**"——而那就是用户看到的重复。
//
// 判据（故意保守）：
//   一个非停用的中文二字组（bigram），在**本群最近 6 条自己发过的话**里
//   出现在 >= 3 条里 → 拦。
//
// 为什么是 3/6 而不是 2/6：正常聊一个话题也会带上同一个词（群里聊十分钟
// "窗台"，每句都带），那不该拦。只有"刚发的几条里密集出现 3 次"才是
// 机器形状。实测现场 6 条里"固定资产"正好 3 次，能抓住且不误伤。
//
// 停用词：功能词/口癖/常用动词，它们在任何对话里都会密集出现。
//
// 这个模块是**纯函数**（输入历史与候选，输出命中词），方便单测；
// 状态（每群最近 6 条）在 host-api 的 recentBotTextsByChat 里，不在这里。

/** 密集出现也不该拦的二字组：功能词、口癖、连词、超常用动词。 */
const STOP_BIGRAMS = new Set([
  // 口癖/语气
  '喵', '的', '了', '吧', '呢', '啊', '嘛', '~',
  //  pronouns / 指示
  '我们', '你们', '他们', '自己', '这个', '那个', '这些', '那些', '这样', '那样',
  // 连词/副词
  '就是', '不是', '还是', '也是', '可是', '但是', '因为', '所以', '如果', '虽然',
  '然后', '现在', '已经', '可以', '应该', '可能', '或者', '而且', '不过', '只是',
  // 超常用动词/形容词
  '什么', '怎么', '为什么', '知道', '觉得', '看', '说', '想', '要', '没',
  '一个', '一下', '一点', '有点', '很多', '真有', '真的', '好', '行',
  // 群聊礼节
  '谢谢', '抱歉', '不好意思',
  // 自称/名字——每句话都可能带，是最常见的误伤源（round 162 实测：
  // host-replyto-echo 的 fixture 里"本喵"出现 3 次，把那条测试也拦了）。
  '本喵', '啾咪', '喵喵',
]);

/** 一段文本里的中文二字组集合（顺序无关，去重）。 */
export function cjkBigrams(text: string): Set<string> {
  const out = new Set<string>();
  // 汉字 + 常见中文标点都不切：标点两侧的汉字不组词，所以先剔标点再滑窗。
  const cleaned = text.replace(/[^一-龥]/gu, ' ');
  for (const run of cleaned.split(/\s+/)) {
    for (let i = 0; i + 2 <= run.length; i++) {
      out.add(run.slice(i, i + 2));
    }
  }
  return out;
}

export interface TopicRepeatHit {
  /** 命中的二字组（如「固定」「资产」）。 */
  bigram: string;
  /** 最近 N 条里有多少条含它。 */
  hits: number;
  /** 参与计数的历史条数。 */
  window: number;
}

/**
 * 候选文本是否在密集复用一个词。
 *
 * `history` 必须是**按时间正序**的本群最近发送记录（旧的在前）。
 * 返回第一个命中的 bigram（有多个时取 hits 最高的），没有命中返回 undefined。
 */
export function findTopicRepeat(
  history: readonly string[],
  candidate: string,
  opts: { window?: number; minHits?: number } = {},
): TopicRepeatHit | undefined {
  const win = opts.window ?? 6;
  const need = opts.minHits ?? 3;
  const recent = history.slice(-win);
  if (recent.length < need) return undefined;

  // 候选自己的 bigram 只用来决定查哪些词——历史里出现次数才是判据。
  const cand = cjkBigrams(candidate);
  if (cand.size === 0) return undefined;

  // 预计算每条历史的 bigram，避免 O(词 × 历史) 的重复清洗。
  const histGrams = recent.map(cjkBigrams);
  let best: TopicRepeatHit | undefined;
  for (const g of cand) {
    if (STOP_BIGRAMS.has(g)) continue;
    let hits = 1;   // 候选自己这条算第 1 次
    for (const h of histGrams) if (h.has(g)) hits++;
    if (hits >= need && (!best || hits > best.hits)) {
      best = { bigram: g, hits, window: recent.length };
    }
  }
  return best;
}
