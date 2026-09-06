// ────────────────────────────────────────
// Core v2 Phase 1 — assembleState（只读、fail-soft）
//
// 从 Belief View + 黑板快照 + knowledge 组装 L1/L2 决策用的只读 state。
// Phase 1 只做三段：identity（静态描述）+ beliefs（本群相关谓词 ≤4 条）
// + knowledge（复用旧 getKnowledge，与旧 judge 同源，保证 shadow 可比）。
// agenda/skills/drives 是 Phase 2/3 的事，这里留空数组占位。
// ────────────────────────────────────────

import { getKnowledge } from '../knowledge/manager.js';
import { getActiveBeliefs } from './beliefs/store.js';
import { getBeliefSnapshot } from './blackboard/snapshot.js';
import { env } from './env-shim.js';
import type { BeliefView } from './beliefs/types.js';
import type { FormattedMessage } from '../shared/types.js';

export interface CoreState {
  /** 身份段（静态，不烧 token 查表） */
  identity: string;
  /** 相关信念（预算 ≤ BELIEF_VIEW_INJECT_MAX，Phase 1 为空库 → 空数组） */
  beliefs: BeliefView[];
  /** 复用旧 knowledge（与旧 judge 同源） */
  knowledge: string;
  /** Phase 2/3 占位 */
  agenda: never[];
  skills: never[];
  drives: Record<string, number>;
  context: { chatId: number; messageId: number };
}

/**
 * 本群相关的 belief 谓词（Phase 1 最小集：群规范 + 人物画像）。
 * 跨群 predicate（person_identity 全局）Phase 2 才进 assembleState。
 */
const CHAT_PREDICATES = ['group.norm', 'person.interest', 'person.trait'];

export async function assembleState(
  chatId: number,
  message: FormattedMessage,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _recent: FormattedMessage[],
): Promise<CoreState> {
  const e = env();
  const budget = e.BELIEF_VIEW_INJECT_MAX;

  // 快照优先：L2 开工后冻结的视图；没有快照读实时（L1 路径）。
  const beliefs: BeliefView[] = [];
  if (e.CORE_BELIEF_VIEW_ENABLED) {
    const snap = getBeliefSnapshot(chatId);
    if (snap) {
      beliefs.push(...snap.slice(0, budget));
    } else {
      for (const pred of CHAT_PREDICATES) {
        if (beliefs.length >= budget) break;
        try {
          const got = getActiveBeliefs(pred);
          for (const b of got) {
            if (beliefs.length >= budget) break;
            if (b.effectiveStatus !== 'contradicted') beliefs.push(b);
          }
        } catch {
          /* 单 predicate 失败不影响其他 */
        }
      }
    }
  }

  let knowledge = '';
  try {
    knowledge = getKnowledge(chatId, {
      permanent: e.JUDGE_KNOWLEDGE_PERMANENT,
      group: e.JUDGE_KNOWLEDGE_GROUP,
    });
  } catch {
    /* fail-soft：没 knowledge 照样判 */
  }

  return {
    identity: 'nyat-bot: group chat catgirl, speaks human-like, never servile',
    beliefs,
    knowledge,
    agenda: [],
    skills: [],
    drives: {},
    context: { chatId, messageId: message.messageId },
  };
}
