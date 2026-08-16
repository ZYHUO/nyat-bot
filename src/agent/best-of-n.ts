// ────────────────────────────────────────
// Best-of-N + verifier — AGI Level 6 Phase 15 (小模型增强核心)
//
// 核心事实: FLOPs 对齐下,测试时计算让小模型超过大 14 倍模型。
// 白嫖延迟: Humanizer 已读延迟 3-8 秒 = 免费并行采样时间。
//
// 硬前提: 没有可靠质量信号时 best-of-N = 随机挑。所以先造 verifier。
// verifier = 判断"这条回复符不符合这个群的调性 / 有没有胡编事实 / 答非所问"。
//
// 按难度分配算力: "早上好"→N=1; "帮我分析这段代码"→N=16+verifier。
// 难度由 judge pipeline 的 action/confidence 近似。
//
// ⚠️ 接线状态: 2026-08-16 已接入 reply.ts §8.5 —— 仅难度 3(技术/长回复)
//    启用,采样 N=2(原版+高温度变体),verifier 二选一,失败回退原版。
//    不做全量 N 采样(主模型 sonnet46 成本线性翻倍 + 同 prompt 方差小)。
// ────────────────────────────────────────
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';

export interface VerifyInput {
  reply: string;
  /** 群调性/上下文摘要(可选,帮助 verifier 判断"符不符合这个群") */
  contextHint?: string;
}

/** 回复复杂度估计(近似难度分类器,纯规则)。返回 1(简单)到 3(难)。 */
export function estimateDifficulty(reply: string, addressed: boolean): 1 | 2 | 3 {
  if (!addressed) return 1;
  const len = reply.length;
  if (len > 400) return 3;                    // 长回复: 可能复杂
  // 技术词(排除"怎么样/咋样"寒暄)——技术判断在前,寒暄排除在后
  if (/代码|分析|比较|为什么|原理|实现|方案|架构|性能/.test(reply)) return 3;
  if (len > 150) return 2;
  if (/怎么样|咋样|如何/.test(reply)) return 1;   // 寒暄
  return 1;
}

/** 根据难度选择采样数 N。 */
export function sampleCountFor(difficulty: 1 | 2 | 3, base: number): number {
  if (difficulty === 1) return 1;
  if (difficulty === 2) return Math.max(2, Math.min(base, 8));
  return Math.max(2, Math.min(base * 2, 16));
}

/**
 * verifier: 单条回复质量打分。返回 0..1(0=最差,1=最好)。
 * 判断维度: 相关性 / 调性符合 / 无胡编 / 回答完整。
 */
export async function verifyReplyQuality(input: VerifyInput): Promise<number> {
  const prompt = `你是回复质量评审。给这条 bot 回复打分(0-1)。考虑: 1)是否答非所问 2)是否胡编事实(没有依据的断言) 3)语气是否符合群聊调性(自然、不过度谄媚) 4)是否完整回答。只输出一个 0-1 数字,不要其他内容。\n\n${input.contextHint ? `群上下文: ${input.contextHint.slice(0, 300)}\n\n` : ''}回复: ${input.reply.slice(0, 800)}`;
  try {
    const res = await callWithFallback({
      usage: 'judge',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      maxTokens: 8,
    });
    const n = Number.parseFloat((res.content ?? '').trim());
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
    return 0.5;
  } catch (err) {
    logger.debug({ err }, 'verifier failed, neutral score');
    return 0.5;
  }
}

/**
 * best-of-N 挑选: 给定 N 条候选,verifier 打分选最优。
 * 返回最优回复 + 其分数。N=1 时直接返回(零开销)。
 */
export async function pickBestOfN(
  candidates: string[],
  contextHint?: string,
): Promise<{ best: string; score: number }> {
  if (candidates.length <= 1) return { best: candidates[0] ?? '', score: 0.5 };
  const scored = await Promise.all(
    candidates.map(async (c) => ({ c, s: await verifyReplyQuality({ reply: c, contextHint }) })),
  );
  scored.sort((a, b) => b.s - a.s);
  return { best: scored[0]!.c, score: scored[0]!.s };
}

/** env 门控: best-of-N 采样数基础值。 */
export function bestOfNBase(): number {
  return env().BEST_OF_N_BASE;
}
