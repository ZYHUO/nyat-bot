// ────────────────────────────────────────
// Core 黑板 — 类型定义 (Phase 0 Task 0.3)
// 类型化共享状态：谁能写什么由 ACL 编译期常量决定。
// ────────────────────────────────────────

export type EntryKind =
  | 'observation' // 谁都能写，L1/L2 都读
  | 'proposal' // 只有 L1 能写（"建议删 test_db.users"）
  | 'authorized_intent' // 只有 gate（用户确认后）能写，L2 只执行这个
  | 'plan' // L2 写
  | 'execution_receipt'; // L2 写，L1 只读播报

export type Author = 'l0' | 'l1' | 'l2' | 'host' | 'gate' | `user:${number}`;

export type EntryStatus = 'open' | 'approved' | 'rejected' | 'consumed' | 'superseded';

export interface BlackboardEntryInput {
  kind: EntryKind;
  author: Author;
  content: string; // JSON
  chatId?: number;
  id?: string; // 不传则 randomUUID
}

export interface BlackboardEntry {
  id: string;
  kind: EntryKind;
  chatId: number | null;
  author: Author;
  content: string;
  status: EntryStatus;
  createdAt: number;
  updatedAt: number;
}
