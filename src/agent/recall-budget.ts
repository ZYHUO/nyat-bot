// ────────────────────────────────────────
// Recall Budget — Context rot 防护 (AGI Level 5 Phase 8, L2)
//
// Chroma 实测: 上下文填充越多模型越退化(迷失在中间/注意力稀释/
// 干扰项误导)。策略: 少召回 + 重排 + 最高信号放最前。
// 简单优先: 固定条数预算, 不做绝对 token 数(现有注入量已很小)。
// ────────────────────────────────────────

import { logger } from '../shared/logger.js';

export interface RecallItem {
  id: number | string;
  content: string;
  kind?: string;
  /** 信号强度 0-1,越高越该放前面。 */
  signal?: number;
}

/**
 * 对召回结果做预算截断 + 重排:
 * 1. 按 signal 降序(已验证/高复用优先)
 * 2. 截断到 budget 条
 * 3. 返回「最高信号在前」的稳定排序(同 signal 按原始顺序)
 */
export function applyRecallBudget(items: RecallItem[], budget: number): RecallItem[] {
  if (budget <= 0 || !items.length) return [];
  const scored = items.map((item, idx) => ({
    item,
    idx,
    score: item.signal ?? 0.5,
  }));
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.slice(0, budget).map((s) => s.item);
}

/**
 * 把注入块放在 prompt 的「黄金区」(最前或最后,避开中间)。
 * 返回 { prompt, block } 组装后的文本;若 block 为空原样返回。
 */
export function placeInGoldenZone(prompt: string, block: string): string {
  if (!block) return prompt;
  // 现有 prompt 末尾通常是执行指令区,把高信号块放最前(开场即见)。
  // 若 prompt 已有同质块(如 [过往经验]),追加到该块内避免割裂。
  if (prompt.includes('[过往经验]')) {
    return prompt.replace(/\[过往经验\]/, `[过往经验]\n${block.trim()}`);
  }
  return `${block.trim()}\n\n${prompt}`;
}

/** 统计注入预算是否超限(诊断用)。 */
export function budgetStatus(blocks: { name: string; items: number; max: number }[]): { over: boolean; lines: string[] } {
  const lines: string[] = [];
  let over = false;
  for (const b of blocks) {
    const ok = b.items <= b.max;
    if (!ok) over = true;
    lines.push(`${b.name}: ${b.items}/${b.max}${ok ? '' : ' ⚠️超限'}`);
  }
  return { over, lines };
}

export { logger };
