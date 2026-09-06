// ────────────────────────────────────────
// Core v2 Phase 1 — L1 proposal → gate → authorized_intent → L2
//
// 接线规则（铁律：L1 永远不能直接写出 L2 可执行的 plan）：
//   1. L1 只写 proposal（"建议做 X，因为…"）。
//   2. gate promotion：host 侧确定性规则把 proposal 转成
//      authorized_intent —— Phase 1 只允许"只读类"自动 promotion
//      （tool 缺省或 classify(tool)==readonly）；写类一律需要用户确认
//      （gateConfirm），无确认不转。
//   3. L2 只读 open/approved 的 authorized_intent，只执行 intent 里
//      声明的 tool，且每次执行前 classify+approve。
//   4. L2 执行完写 execution_receipt（open=中间态，consumed=完成），
//      消费掉的 intent 标 consumed（一次性，防重放）。
// ────────────────────────────────────────

import { listEntries, readEntry, setEntryStatus, writeEntry } from './blackboard/store.js';
import { classify } from './permission/tiers.js';
import { approve } from './permission/gate.js';
import { logger } from '../shared/logger.js';
import type { BlackboardEntry } from './blackboard/types.js';

export interface PromotionResult {
  promoted: boolean;
  intentId?: string;
  reason?: string;
}

/**
 * gate promotion（host 侧，确定性）：把一条 open proposal 转成
 * authorized_intent。Phase 1 自动 promotion 只放行只读类：
 * proposal content 必须是 {"tool": string, "args": {...}, "why": string}，
 * 且 classify(tool, args) === 'readonly'。写类返回
 * {promoted:false, reason:'needs-user-confirm'}，等 gateConfirm。
 */
export function promoteProposal(proposalId: string): PromotionResult {
  const p = readEntry(proposalId);
  if (!p) return { promoted: false, reason: 'proposal not found' };
  if (p.kind !== 'proposal') return { promoted: false, reason: 'not a proposal' };
  if (p.status !== 'open') return { promoted: false, reason: `proposal status=${p.status}` };
  let body: { tool?: string; args?: unknown; why?: string };
  try {
    body = JSON.parse(p.content) as { tool?: string; args?: unknown; why?: string };
  } catch {
    return { promoted: false, reason: 'proposal content not JSON' };
  }
  const tool = body.tool ?? 'unknown';
  if (classify(tool, body.args ?? {}) !== 'readonly') {
    return { promoted: false, reason: 'needs-user-confirm' };
  }
  const w = writeEntry({
    kind: 'authorized_intent',
    author: 'gate',
    content: JSON.stringify({ tool, args: body.args ?? {}, why: body.why ?? '', from: proposalId }),
    chatId: p.chatId ?? undefined,
  });
  if (!w.ok) return { promoted: false, reason: w.reason ?? 'write failed' };
  setEntryStatus(proposalId, 'consumed');
  logger.info({ proposalId, intentId: w.id, tool }, 'core gate promoted proposal → intent');
  return { promoted: true, intentId: w.id };
}

/** L2 取本群待执行的 intents（open/approved，最多 5 条）。 */
export function pendingIntents(chatId: number, limit = 5): BlackboardEntry[] {
  const opens = listEntries('authorized_intent', 'open', limit);
  const approved = listEntries('authorized_intent', 'approved', limit);
  return [...opens, ...approved]
    .filter((en) => en.chatId === chatId || en.chatId === null)
    .slice(0, limit);
}

export interface L2ExecuteResult {
  executed: boolean;
  tool?: string;
  tier?: string;
  receiptId?: string;
  reason?: string;
}

/**
 * L2 执行一条 intent（Phase 1：declarative 校验 + receipt，不调真工具）。
 * 流程：读 intent → 解析 tool/args → classify → approve →
 * 写 execution_receipt(open) → 标 intent consumed → receipt 标 consumed。
 * 真工具调用是 Phase 2 的事（execute.ts），这里只证明"线是通的"。
 */
export async function executeIntent(intentId: string): Promise<L2ExecuteResult> {
  const intent = readEntry(intentId);
  if (!intent) return { executed: false, reason: 'intent not found' };
  if (intent.kind !== 'authorized_intent') return { executed: false, reason: 'not an intent' };
  if (intent.status !== 'open' && intent.status !== 'approved') {
    return { executed: false, reason: `intent status=${intent.status}` };
  }
  let body: { tool?: string; args?: unknown; why?: string };
  try {
    body = JSON.parse(intent.content) as { tool?: string; args?: unknown; why?: string };
  } catch {
    return { executed: false, reason: 'intent content not JSON' };
  }
  const tool = body.tool ?? 'unknown';
  const args = body.args ?? {};
  const tier = classify(tool, args);
  const ap = await approve(tier, intentId);
  if (!ap.ok) return { executed: false, tool, tier, reason: ap.reason ?? 'denied' };
  const receipt = writeEntry({
    kind: 'execution_receipt',
    author: 'l2',
    content: JSON.stringify({
      intent: intentId,
      tool,
      args,
      dryRun: true,
      note: 'Phase 1 dry-run: no real tool executed',
    }),
    chatId: intent.chatId ?? undefined,
  });
  if (!receipt.ok) return { executed: false, tool, tier, reason: 'receipt write failed' };
  setEntryStatus(intentId, 'consumed');
  // Phase 1：dry-run 直接标完成（真执行在 Phase 2，这里证明 receipt 可见性切换）
  setEntryStatus(receipt.id!, 'consumed');
  logger.info({ intentId, tool, tier, receiptId: receipt.id }, 'core L2 executed intent (dry-run)');
  return { executed: true, tool, tier, receiptId: receipt.id };
}
