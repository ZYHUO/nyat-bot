// ────────────────────────────────────────
// Core v2 — 统一出口 (Phase 0)
// Phase 1+ 从这里 import；主路径暂不接任何 core（纯地基阶段）。
// ────────────────────────────────────────

export * from './beliefs/types.js';
export { upsertBelief, recordOutcome, getActiveBeliefs } from './beliefs/store.js';
export { laplaceConfidence, decayedConfidence } from './beliefs/confidence.js';
export { contradict, detectSemanticConflicts } from './beliefs/contradict.js';
export * from './blackboard/types.js';
export { BLACKBOARD_ACL, canWrite } from './blackboard/acl.js';
export { writeEntry, readEntry, listEntries, setEntryStatus } from './blackboard/store.js';
export {
  freezeBeliefSnapshot,
  getBeliefSnapshot,
  clearBeliefSnapshot,
  visibleToL1,
} from './blackboard/snapshot.js';
export { classify } from './permission/tiers.js';
export type { Tier } from './permission/tiers.js';
export { approve, gateConfirm } from './permission/gate.js';
