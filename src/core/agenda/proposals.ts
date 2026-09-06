// ────────────────────────────────────────
// Core v2 Phase 3 — agenda proposals（候选动作生成器）
//
// 原 self-play / goal-check / unified-tick 的角色变成 proposal 源：
// 世界变化 / 到期 goal / 缺席熟人 / RSS 新料 / self-play 就绪 →
// 候选动作列表。只生成候选，不决策、不执行。
//
// 决策仍是 unified-tick 的 decideTick（LLM）+ executeVerdict（否决链）。
// Phase 3 加两样：drive 值随包进 prompt（LLM 看得见），
// suppressor 在执行前否决 satiated 动作（host 算，LLM 拦不住也绕不过）。
// ────────────────────────────────────────

import type { CandidateAction, ScoreWorld } from '../drives/score.js';

export interface ProposalInput {
  world: Omit<ScoreWorld, 'absentUsers'> & {
    groups: { chatId: number; silentSec: number; lastTexts?: string }[];
    dueGoals: { id: number; topic: string }[];
    absentUsers: { chatId: number; uid: number; name: string; absentDays: number }[];
    shareCandidates?: { fromChatId: number; messageId: number; toChatId?: number }[];
  };
  masterConfigured: boolean;
}

const TWO_HOURS = 7200;

/**
 * 生成候选动作（确定性规则，与 tick prompt 里的硬否决对齐）：
 *  - 主人沉默 ≥4h → care_master
 *  - 群冷场 ≥2h（取最冷的一个） → group_speak
 *  - 缺席 ≥3 天的熟人（取第一个） → remember_user
 *  - 到期 goal（取第一个） → check_goal
 *  - self-play 就绪 → self_play
 *  - 有 share 候选（取第一个） → share
 *  - 兜底 quiet
 * 调用方（tick）再按 drive 增益排序 + suppressor 过滤 + LLM 终裁。
 */
export function proposeActions(input: ProposalInput): CandidateAction[] {
  const { world } = input;
  const out: CandidateAction[] = [];

  if (
    input.masterConfigured &&
    world.masterSilentSec !== null &&
    world.masterSilentSec >= 4 * 3600
  ) {
    out.push({ type: 'care_master' });
  }

  const coldest = [...world.groups].sort((a, b) => b.silentSec - a.silentSec)[0];
  if (coldest && coldest.silentSec >= TWO_HOURS) {
    out.push({ type: 'group_speak', chatId: coldest.chatId });
  }

  const absent = world.absentUsers.find((u) => u.absentDays >= 3);
  if (absent) {
    out.push({ type: 'remember_user', chatId: absent.chatId });
  }

  const goal = world.dueGoals[0];
  if (goal) {
    out.push({ type: 'check_goal', goalId: goal.id });
  }

  if (world.selfPlayCooldownLeftSec <= 0 && input.masterConfigured) {
    out.push({ type: 'self_play' });
  }

  const share = input.world.shareCandidates?.[0];
  if (share) {
    out.push({ type: 'share', fromChatId: share.fromChatId, toChatId: share.toChatId ?? share.fromChatId });
  }

  if (out.length === 0) out.push({ type: 'quiet' });
  return out;
}

/** 候选动作 → tick prompt 可读行（LLM 看得见 drive 排序依据）。 */
export function formatProposals(
  actions: CandidateAction[],
  scores: Map<string, number>,
): string {
  const key = (a: CandidateAction): string => JSON.stringify(a);
  return actions
    .map((a) => {
      const s = scores.get(key(a)) ?? 0;
      switch (a.type) {
        case 'care_master':
          return `  - care_master (drive增益 ${s.toFixed(2)})`;
        case 'group_speak':
          return `  - group_speak 群${a.chatId} (drive增益 ${s.toFixed(2)})`;
        case 'remember_user':
          return `  - remember_user 群${a.chatId} (drive增益 ${s.toFixed(2)})`;
        case 'self_play':
          return `  - self_play (drive增益 ${s.toFixed(2)})`;
        case 'check_goal':
          return `  - check_goal #${a.goalId} (drive增益 ${s.toFixed(2)})`;
        case 'share':
          return `  - share 群${a.fromChatId}→群${a.toChatId} (drive增益 ${s.toFixed(2)})`;
        case 'quiet':
          return `  - quiet (drive增益 0)`;
      }
    })
    .join('\n');
}
