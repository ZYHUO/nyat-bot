// ────────────────────────────────────────
// Core Permission — 授权审批 gate (Phase 0 Task 0.4)
//
// L2 的每一次工具调用，先 classify 再 approve，host 侧拦截，
// 不在 LLM 自查里。
//
//   readonly          → 直接放行
//   reversible_write  → 黑板里要有对应的 authorized_intent（open/approved）
//   irreversible      → dry-run + 显式用户确认（gateConfirm）
// ────────────────────────────────────────

import { readEntry, setEntryStatus } from '../blackboard/store.js';
import type { Tier } from './tiers.js';

/** 内存确认表：intentId → 确认用户。进程重启清空（确认必须新鲜）。 */
const confirmations = new Map<string, number>();

/** 用户显式确认某个 intent（Telegram 确认按钮 / 主人指令调用）。 */
export function gateConfirm(intentId: string, opts: { userId: number }): void {
  confirmations.set(intentId, opts.userId);
}

export function _resetGateForTest(): void {
  confirmations.clear();
}

export interface ApproveResult {
  ok: boolean;
  reason?: string;
}

/**
 * authorized_intent 的 scope 校验：entry 必须存在、kind 对、状态未被拒绝/
 * 消费。content 里可选 scope 字段做进一步约束（Phase 0 只做存在性+状态）。
 */
function hasValidIntent(intentId: string): boolean {
  const e = readEntry(intentId);
  if (!e) return false;
  if (e.kind !== 'authorized_intent') return false;
  return e.status === 'open' || e.status === 'approved';
}

export async function approve(tier: Tier, intentId: string): Promise<ApproveResult> {
  if (tier === 'readonly') return { ok: true };
  if (tier === 'reversible_write') {
    if (!intentId) return { ok: false, reason: 'reversible_write requires intentId' };
    if (!hasValidIntent(intentId)) {
      return { ok: false, reason: `no valid authorized_intent: ${intentId}` };
    }
    return { ok: true };
  }
  // irreversible：必须先有有效 intent，再要用户显式确认。
  // 确认后把 intent 标 consumed（一次性，防止重放）。
  if (!hasValidIntent(intentId)) {
    return { ok: false, reason: `no valid authorized_intent: ${intentId}` };
  }
  if (!confirmations.has(intentId)) {
    return { ok: false, reason: 'irreversible requires explicit user confirmation' };
  }
  confirmations.delete(intentId);
  setEntryStatus(intentId, 'consumed');
  return { ok: true };
}
