// ────────────────────────────────────────
// Core v2 Phase 4 — skill 生命周期类型
//
// skills 旧表 = 能力库（唯一真相，继续写）。
// core_skill_lifecycle = 门（候选 → 验证 → 人审 → 发布）。
//
//   proposed   自玩/蒸馏产出的候选（LLM 提议，host 落行）
//   verified   沙箱 verify 通过（确定性检查 + 试跑无红线）
//   approved   主人显式批准（Telegram 确认 / 主人指令）
//   published  已写入 skills 表（skill_id 回填）
//   rejected   任一步失败/被拒（verify_log 留原因）
//
// 铁律：published 之前 skill 永不进 findRelevantSkills（查不到=用不上）；
// 人审是唯一放行 published 的门，LLM 自己批不了自己。
// ────────────────────────────────────────

export type LifecycleStatus = 'proposed' | 'verified' | 'approved' | 'published' | 'rejected';

export const LIFECYCLE_STATUSES: LifecycleStatus[] = [
  'proposed',
  'verified',
  'approved',
  'published',
  'rejected',
];

export interface LifecycleRow {
  id: number;
  name: string;
  status: LifecycleStatus;
  verifyLog: string | null;
  reviewer: number | null;
  reviewedAt: number | null;
  skillId: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProposeInput {
  name: string;
  triggerWhen: string;
  steps: string;
  pitfalls?: string;
  summary?: string;
  tags?: string[];
}
