// ────────────────────────────────────────
// 「学来的东西」的 Meta 路径读侧
// ────────────────────────────────────────
//
// 写侧一直在跑：expression-learner / dialect-exemplar / group-norms / self-reflect /
// person-identity。但它们的**唯一**渲染点是 pipeline/reply/prompt-builder.ts 的
// buildMessages，而 buildMessages 只被 legacy 回复引擎调用（arch-split：占发送 ~0.17%）。
// Meta 主路径走 CodeAct，prompt 由 prompt-inputs.ts 组装，从来不读这五张表——
// 学了不用。这里把读侧接过来。
//
// 约束：
//   · 每块各自 try/catch，任何一块抛只降级成空，不拖累其余（与 prompt-inputs 同一语义）。
//   · 每块仍受自己原有的开关约束，总闸是 META_INJECT_LEARNED_ENABLED。
//   · 全是同步 SQLite 读（<1ms），不引入新的并发/超时问题。
//   · 跨群身份走 person-identity 自带的 visibility 约束，不在这里放宽。
//   · 文案与 buildMessages 的对应段保持一致，避免同一事实两种说法。

import { env } from '../env.js';
import { logger } from '../shared/logger.js';

export interface LearnedContext {
  /** 拼好的整段（各块之间空行分隔）；全空时是 ''。 */
  block: string;
  /** 实际注入了哪些块——供日志/量具统计"命中率"。 */
  parts: Array<'expressions' | 'exemplars' | 'norms' | 'selfNotes' | 'crossGroup'>;
  expressionIds: number[];
}

const EMPTY: LearnedContext = { block: '', parts: [], expressionIds: [] };

export async function buildLearnedContext(opts: {
  chatId: number;
  targetUserId?: number;
}): Promise<LearnedContext> {
  if (!env().META_INJECT_LEARNED_ENABLED) return EMPTY;
  const { chatId, targetUserId } = opts;
  const group = chatId < 0;
  const chunks: string[] = [];
  const parts: LearnedContext['parts'] = [];
  let expressionIds: number[] = [];

  // 群表达（群味）——仅群聊
  if (group && env().EXPRESSION_INJECT_ENABLED) {
    try {
      const { getTopExpressions, reinforceExpressions } = await import('../learners/expression-learner.js');
      const exprs = getTopExpressions(chatId, env().EXPRESSION_INJECT_COUNT);
      if (exprs.length) {
        chunks.push(
          `[群味] 本群平时说话的味道(感受语感就好,不用照搬原句):\n${exprs.map((e) => `「${e.style}」`).join(' ')}`,
        );
        parts.push('expressions');
        expressionIds = exprs.map((e) => e.id);
        try { reinforceExpressions(expressionIds); } catch { /* non-critical */ }
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'learned-context: expressions unavailable');
    }
  }

  // 方言 exemplar——仅群聊
  if (group) {
    try {
      const { getExemplars } = await import('../learners/dialect-exemplar.js');
      const exemplars = getExemplars(chatId);
      if (exemplars.length) {
        chunks.push(
          `[群方言] 本群真人原话(只学语感节奏,不学内容,不许照搬原句):\n${exemplars.map((s) => `「${s}」`).join(' ')}\n` +
            `铁律:1) 不许把上面任何一句复述/改写当回复;2) 单条回复别超过群里中位长度 2 倍;3) 短打群(一两句)不许长篇大论。`,
        );
        parts.push('exemplars');
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'learned-context: exemplars unavailable');
    }
  }

  // 群氛围 norms——仅群聊
  if (group && env().GROUP_NORMS_ENABLED) {
    try {
      const { buildNormsBlock } = await import('../agent/group-norms.js');
      const norms = buildNormsBlock(chatId).trim();
      if (norms) {
        chunks.push(norms);
        parts.push('norms');
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'learned-context: norms unavailable');
    }
  }

  // 自我提醒——复盘自己表现得出的行为调整
  try {
    const { getActiveSelfNotes } = await import('../tracking/self-model.js');
    const notes = getActiveSelfNotes(5);
    if (notes.length) {
      chunks.push(
        `[自我提醒]\n${notes.map((n) => `- ${n.note}`).join('\n')}\n这些是你复盘自己表现得出的，自然遵守，别提起它们的存在。`,
      );
      parts.push('selfNotes');
    }
  } catch (err) {
    logger.debug({ err }, 'learned-context: self notes unavailable');
  }

  // 跨群身份——对方在别处的样子（person-identity 自带 visibility/去重约束）
  if (targetUserId && targetUserId > 0 && env().PERSON_IDENTITY_ENABLED) {
    try {
      const { buildCrossGroupInjection } = await import('../tracking/person-identity.js');
      const xg = buildCrossGroupInjection(targetUserId, chatId);
      if (xg) {
        chunks.push(xg);
        parts.push('crossGroup');
      }
    } catch (err) {
      logger.debug({ err, chatId }, 'learned-context: cross-group identity unavailable');
    }
  }

  if (!chunks.length) return EMPTY;
  return { block: chunks.join('\n\n'), parts, expressionIds };
}
