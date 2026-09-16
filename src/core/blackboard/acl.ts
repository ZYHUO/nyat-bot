// ────────────────────────────────────────
// Core 黑板 — ACL（编译期常量，Phase 0 Task 0.3）
//
// 铁律：L1 永远不能直接写出一个 L2 可执行的 plan。
// L1 的升级请求只能是 proposal，必须被 gate 校验后转成
// authorized_intent，L2 才动。
// ────────────────────────────────────────

import type { Author, EntryKind } from './types.js';

export const BLACKBOARD_ACL: Record<EntryKind, Author[]> = {
  observation: ['l0', 'l1', 'l2', 'host'],
  proposal: ['l1'], // L1 只能写提案
  authorized_intent: ['gate'], // 只有 gate 能写（用户确认后）
  plan: ['l2'],
  execution_receipt: ['l2'],
};

export function canWrite(kind: EntryKind, author: Author): boolean {
  return (BLACKBOARD_ACL[kind] ?? []).includes(author);
}
