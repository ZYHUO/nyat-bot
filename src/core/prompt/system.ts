// ────────────────────────────────────────
// Core v2 Phase 1 — 单一 system prompt 组装器
//
// identity + beliefs + knowledge 五段式里 Phase 1 只做三段：
// identity（静态）+ beliefs（预算 ≤4 条，空库时整段省略）+ knowledge
// （复用旧 getKnowledge，与旧 judge 同源）。
// agenda/skills/drives 是 Phase 2/3 的事，这里只留段头占位（注释），
// 不输出空段（省 token，不污染 prompt）。
//
// 设计约束：L1 的 microJudge 仍用旧 task/judge.md（shadow 可比性）——
// 这个组装器是给 Phase 1.5 / Phase 2 的 deliberate() 用的，Phase 1
// 先落地 + 单测，不接 live 路径。
// ────────────────────────────────────────

import type { CoreState } from '../state.js';
import { env } from '../env-shim.js';

export interface AssembledPrompt {
  system: string;
  beliefCount: number;
  hasKnowledge: boolean;
}

export function assembleSystemPrompt(state: CoreState): AssembledPrompt {
  const e = env();
  const sections: string[] = [state.identity];

  const budget = e.BELIEF_VIEW_INJECT_MAX;
  const fresh = state.beliefs
    .filter((b) => b.effectiveStatus === 'active')
    .sort((a, b) => b.decayedConfidence - a.decayedConfidence)
    .slice(0, budget);
  let beliefCount = 0;
  if (fresh.length > 0) {
    const lines = fresh.map(
      (b) => `- [${b.predicate} conf=${b.decayedConfidence.toFixed(2)}] ${b.summary}`,
    );
    sections.push(`[当前信念]\n${lines.join('\n')}`);
    beliefCount = fresh.length;
  }

  let hasKnowledge = false;
  if (state.knowledge && state.knowledge.trim()) {
    sections.push(`[知识库]\n${state.knowledge.trim()}`);
    hasKnowledge = true;
  }

  // Phase 2/3 占位：agenda / skills / drives（有内容才加段，无内容省略）
  // if (state.agenda.length) sections.push(...)
  // if (state.skills.length) sections.push(...)

  return { system: sections.join('\n\n'), beliefCount, hasKnowledge };
}
