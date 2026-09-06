// ────────────────────────────────────────
// Core v2 Phase 3 — drives 类型
//
// 四个 drive（只做 scorer + suppressor，无执行权）：
//   connection — 想跟人连着（主人沉默久/群冷场 → 值高）
//   curiosity  — 想知道（RSS 新料/到期 goal/缺席熟人 → 值高）
//   competence — 想把事做成（到期 goal/未完成 subtask → 值高）
//   autonomy   — 想自己玩（self-play 就绪/刚切换生活状态 → 值高）
// ────────────────────────────────────────

export type DriveName = 'connection' | 'curiosity' | 'competence' | 'autonomy';

export const DRIVE_NAMES: DriveName[] = ['connection', 'curiosity', 'competence', 'autonomy'];

export interface DriveState {
  name: DriveName;
  /** 0..1：当前多想满足这个 drive */
  value: number;
  /** ≥0：近期满足度，抑制重复发起（satiation 生效中 → suppressor 否决） */
  satiation: number;
  updatedAt: number;
}
