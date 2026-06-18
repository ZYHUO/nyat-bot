// ────────────────────────────────────────
// burstHint 合成 — 状态块的"裁剪"与"排序"彻底解耦
// ────────────────────────────────────────
//
// 回复前注入的一堆状态块([此刻的你]/[本群黑话]/[你的念头]/指令…)各带两个
// 独立的键:
//   order = 文本位置(升序 = 越靠前 = 离 CURRENT_MESSAGE 越远)
//   keep  = 预算裁剪重要度(升序 = 越先保;< KEEP_ALWAYS 必留,永不被裁)
//
// 旧设计用一个 priority 同时管"位置"和"重要度",于是"念头(最重要)"被排到
// 块最前(离当前消息最远)—— 正好和"写手顺着念头开笔"的意图相反。拆开后:
// 重要度决定谁在预算紧张时活下来,位置决定活下来的块按 recency 怎么排。

/** keep < 此阈值的块视为"必留",不受预算裁剪。 */
export const KEEP_ALWAYS = 10;

export interface CtxPart {
  /** 文本位置:升序 = 越靠前(离 CURRENT_MESSAGE 越远) */
  order: number;
  /** 裁剪重要度:升序 = 越先保;< KEEP_ALWAYS 必留 */
  keep: number;
  text: string;
}

/**
 * 两遍合成:
 *  ① 裁剪:按 keep 升序遍历,keep<KEEP_ALWAYS 必留,其余在预算内择优保留;
 *  ② 排序:保留下来的按 order 升序渲染。
 * 返回拼好的 burstHint,空则 undefined。
 */
export function assembleBurstHint(parts: CtxPart[], budgetChars: number): string | undefined {
  let used = 0;
  const kept: Array<{ order: number; text: string }> = [];
  for (const part of [...parts].sort((a, b) => a.keep - b.keep)) {
    if (part.keep < KEEP_ALWAYS || used + part.text.length <= budgetChars) {
      kept.push({ order: part.order, text: part.text });
      used += part.text.length;
    }
  }
  return kept.sort((a, b) => a.order - b.order).map((p) => p.text).join('\n\n') || undefined;
}
