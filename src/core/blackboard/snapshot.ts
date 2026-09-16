// ────────────────────────────────────────
// Core 黑板 — 快照隔离 (Phase 0 Task 0.5)
//
// L2 开工时冻结一份 belief 快照；L2 的中间态只写 execution_receipt
// （最终态），不写 observation/proposal。L1 读到的永远是 L2 开工前
// 的快照 + 已完成的 receipt，永远读不到 L2 写一半的中间态 →
// 不会对用户撒谎。
//
// 内存实现（进程级）：freeze 时把某 chat 的 belief 行 deep-copy 进
// Map；visibleToL1(entry) 只看 receipt 状态（open=中间态不可见，
// consumed/approved=完成可见）。重启丢快照（fail-soft：无快照时
// L1 直接读 belief 当前值，不拦路）。
// ────────────────────────────────────────

import type { BeliefView } from '../beliefs/types.js';
import type { BlackboardEntry } from './types.js';

/** chatId → 开工时冻结的 belief 视图 */
const snapshots = new Map<number, { at: number; beliefs: BeliefView[] }>();

export function freezeBeliefSnapshot(chatId: number, beliefs: BeliefView[]): void {
  snapshots.set(chatId, {
    at: Math.floor(Date.now() / 1000),
    beliefs: JSON.parse(JSON.stringify(beliefs)) as BeliefView[],
  });
}

export function getBeliefSnapshot(chatId: number): BeliefView[] | null {
  return snapshots.get(chatId)?.beliefs ?? null;
}

export function clearBeliefSnapshot(chatId: number): void {
  snapshots.delete(chatId);
}

export function _resetSnapshotForTest(): void {
  snapshots.clear();
}

/**
 * L1 能不能读这条 entry：
 *  - 非 receipt（observation/proposal/plan/authorized_intent）：L1 本来就有
 *    读权（ACL 管写不禁读），返回 true。
 *  - execution_receipt：open = L2 写一半的中间态 → 不可见；approved/
 *    consumed = 已完成 → 可见播报。rejected/superseded → 不可见。
 */
export function visibleToL1(entry: BlackboardEntry | null | undefined): boolean {
  if (!entry) return false;
  if (entry.kind !== 'execution_receipt') return true;
  return entry.status === 'approved' || entry.status === 'consumed';
}
