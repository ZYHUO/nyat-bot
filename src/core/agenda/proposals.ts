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
    groups: { chatId: number; silentSec: number; lastTexts?: string; botSilentSec?: number }[];
    /**
     * 它自己起过、但没说出口的念头：影子判定 speak 而线上最终没发的那批。
     * 这是目前唯一现成的"我有自己的事"来源——比 goals.origin='self'（0 行）
     * 便宜，而且内容就是它当时自己想说的话。
     */
    unactedImpulses?: Array<{ chatId: number; about: string; minutesAgo: number; verdict: string }>;
    dueGoals: { id: number; topic: string }[];
    absentUsers: { chatId: number; uid: number; name: string; absentDays: number }[];
    shareCandidates?: { fromChatId: number; messageId: number; toChatId?: number }[];
  };
  masterConfigured: boolean;
}

const TWO_HOURS = 7200;
/** 我自己在这个群多久没开口才够资格再说话（与"群多安静"无关）。 */
const SELF_SPEAK_MIN_GAP_SEC = 45 * 60;

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

  // ── 自己的事 + 自己的间隔（2026-09-19）────────────────────────
  // 上面那条 group_speak 的门槛是"群冷场 2 小时"。问题是：它把"开口的理由"
  // 绑定在**房间的空旷**上，于是自主性只能寄生在无人时——人在场且热络时，
  // 没有任何一条规则会触发自发行为。创始人指出这就是"自主是给人看的"。
  //
  // 新路由换成两个跟"我自己"有关的条件：
  //   ① 我自己在这个群有没说出口的念头（unactedImpulses）——"我有自己的事"
  //   ② 我自己在这个群已经 N 分钟没开口（botSilentSec）——"我不会连续念叨"
  // 房间多安静降为辅助，不再是前提。这两条都取自宿主可观测事实，不是 LLM 自述。
  for (const g of world.groups) {
    const own = world.unactedImpulses?.find((u) => u.chatId === g.chatId);
    if (!own) continue;
    const gap = g.botSilentSec ?? 0;
    if (gap < SELF_SPEAK_MIN_GAP_SEC) continue;
    if (out.some((a) => a.type === 'group_speak' && a.chatId === g.chatId)) continue;
    out.push({ type: 'group_speak', chatId: g.chatId, about: own.about });
  }

  // 在场但静默的参与：有没说出口的念头，但还没到开口的间隔 → 先把念头记下来。
  // 用户侧零可见变化，但它开始在有人的环境里积累"自己的事"。
  for (const u of world.unactedImpulses ?? []) {
    const g = world.groups.find((x) => x.chatId === u.chatId);
    if (g && (g.botSilentSec ?? 0) >= SELF_SPEAK_MIN_GAP_SEC) continue; // 该说就说不该记
    if (out.some((a) => a.type === 'group_speak' && a.chatId === u.chatId)) continue;
    out.push({ type: 'note_impulse', chatId: u.chatId, about: u.about });
    break; // 一次只记一条，别把后台跑成批处理
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
