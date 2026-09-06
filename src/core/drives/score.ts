// ────────────────────────────────────────
// Core v2 Phase 3 — drive scorer（只打分，不执行）
//
// 两个函数：
//   deriveDriveValues(world) — 世界状态包 → 四个 drive 值（host 算，
//     确定性规则；LLM 不参与）。unified-tick 每 tick 调一次。
//   scoreAction(action, drives) — 候选动作的期望 drive 增益。只打分。
//   suppress(action, drives) — satiation 抑制检查。返回否决原因或 null。
//
// 世界状态输入是 unified-tick 的 WorldState 子集（结构化字段，不传 prompt）。
// ────────────────────────────────────────

import type { DriveName } from './types.js';
import type { DriveState } from './types.js';

/** unified-tick WorldState 里 scorer 关心的字段（子集接口，防大耦合）。 */
export interface ScoreWorld {
  masterSilentSec: number | null;
  lastCareAgoSec: number;
  groups: { chatId: number; silentSec: number }[];
  dueGoals: { id: number }[];
  rssNewCount: number;
  absentUsers: { chatId: number; uid: number }[];
  selfPlayCooldownLeftSec: number;
  lifeTransition?: string | null;
}

/** 候选动作（与 TickAction 同构的子集；Phase 3 只给已有动作打分，不发明新动作）。 */
export type CandidateAction =
  | { type: 'care_master' }
  | { type: 'group_speak'; chatId: number }
  | { type: 'remember_user'; chatId: number }
  | { type: 'self_play' }
  | { type: 'check_goal'; goalId: number }
  | { type: 'share'; fromChatId: number; toChatId: number }
  | { type: 'quiet' };

const HOUR = 3600;

/**
 * 世界状态 → drive 值（host 确定性规则）：
 *  connection：主人沉默越久越高（封顶 8h=1）；群冷场加成。
 *  curiosity：RSS 新料/缺席熟人/生活切换 → 高。
 *  competence：到期 goal 越多越高。
 *  autonomy：self-play 就绪 → 高。
 */
export function deriveDriveValues(w: ScoreWorld): Record<DriveName, number> {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  // connection：主人沉默 8h 封顶；上次关心越久加成（24h 封顶 +0.3）
  const masterPart =
    w.masterSilentSec === null ? 0.3 : clamp(w.masterSilentSec / (8 * HOUR));
  const carePart = w.lastCareAgoSec >= Number.MAX_SAFE_INTEGER ? 0.3 : clamp(w.lastCareAgoSec / (24 * HOUR)) * 0.3;
  const coldGroups = w.groups.filter((g) => g.silentSec > 2 * HOUR).length;
  const connection = clamp(masterPart * 0.6 + carePart + Math.min(0.3, coldGroups * 0.1));

  // curiosity：RSS 新料（5 条封顶）+ 缺席熟人（3 人封顶）+ 生活切换
  const curiosity = clamp(
    Math.min(0.5, w.rssNewCount * 0.1) +
      Math.min(0.3, w.absentUsers.length * 0.1) +
      (w.lifeTransition ? 0.2 : 0),
  );

  // competence：到期 goal（3 个封顶 0.9）
  const competence = clamp(Math.min(0.9, w.dueGoals.length * 0.3));

  // autonomy：self-play 就绪 0.7，否则 0.1（保底一点自主性）
  const autonomy = w.selfPlayCooldownLeftSec <= 0 ? 0.7 : 0.1;

  return { connection, curiosity, competence, autonomy };
}

/** 动作 → 它服务的 drive（静态映射）。quiet 不服务任何 drive。 */
export function drivesServedBy(a: CandidateAction): DriveName[] {
  switch (a.type) {
    case 'care_master':
      return ['connection'];
    case 'group_speak':
      return ['connection'];
    case 'remember_user':
      return ['connection', 'curiosity'];
    case 'self_play':
      return ['autonomy', 'curiosity'];
    case 'check_goal':
      return ['competence'];
    case 'share':
      return ['curiosity', 'connection'];
    case 'quiet':
      return [];
  }
}

/** 期望增益 = 所服务 drive 的值之和（quiet 恒 0）。纯函数。 */
export function scoreAction(a: CandidateAction, drives: Record<DriveName, number>): number {
  return drivesServedBy(a).reduce((s, d) => s + (drives[d] ?? 0), 0);
}

/**
 * satiation 抑制检查：动作所服务的任一 drive 处于 satiation 高位
 * （≥0.5）→ 否决（返回原因）；否则 null（放行，由 tick 原有否决链继续）。
 * 纯函数，不读库（调用方传 getDrives() 进来）。
 */
export function suppress(a: CandidateAction, states: DriveState[]): string | null {
  if (a.type === 'quiet') return null;
  const served = drivesServedBy(a);
  for (const d of served) {
    const st = states.find((s) => s.name === d);
    if (st && st.satiation >= 0.5) {
      return `satiated:${d}=${st.satiation.toFixed(2)}`;
    }
  }
  return null;
}
