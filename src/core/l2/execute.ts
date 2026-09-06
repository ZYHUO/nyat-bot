// ────────────────────────────────────────
// Core v2 Phase 5 — L2 真执行（execute.ts）
//
// executeIntent 的 Phase 1 版只 dry-run（写 receipt 不调工具）。
// 这个模块是真执行：intent → classify → approve → 调 host 工具 →
// receipt（dryRun:false）→ intent consumed。
//
// 安全边界（与 gate 同源，不另发明规则）：
//   readonly           → 直接执行（memory.search / chats.recentMessages / web.search）
//   reversible_write   → 必须有有效 authorized_intent（approve 里验）
//   irreversible       → 必须 gateConfirm 过（approve 里验，一次性）
//   未知工具           → classify 默认 irreversible → 无确认直接拒
//
// 工具表：只接 3 个只读 + 1 个可逆写（sendText 经主人 DM 确认链）。
// computer.run / admin.* 永不直连——L2 没有执行它们的资格，
// 想调必须走 subagent executor（那套有 bwrap + 审计）。
// ────────────────────────────────────────

import { readEntry, writeEntry, setEntryStatus } from '../blackboard/store.js';
import { classify } from '../permission/tiers.js';
import { approve } from '../permission/gate.js';
import { logger } from '../../shared/logger.js';

export interface RealExecuteResult {
  executed: boolean;
  tool?: string;
  tier?: string;
  receiptId?: string;
  data?: unknown;
  reason?: string;
}

type ToolFn = (args: Record<string, unknown>, chatId: number | null) => Promise<unknown>;

/** 只读工具实现（host 侧直调，不经 LLM）。 */
async function toolMemorySearch(args: Record<string, unknown>): Promise<unknown> {
  const { searchMemory } = await import('../../memory/chroma.js');
  const query = String(args['query'] ?? '').slice(0, 200);
  if (!query) throw new Error('memory.search requires query');
  const chatId = Number(args['chatId'] ?? 0) || 0;
  // searchMemory(chatId, query)：chatId=0 → 全局搜（与 chroma 签名一致）
  return searchMemory(chatId, query).catch(() => []);
}

async function toolRecentMessages(args: Record<string, unknown>): Promise<unknown> {
  const { getRecent } = await import('../../pipeline/context/manager.js');
  const chatId = Number(args['chatId'] ?? 0);
  if (!chatId) throw new Error('chats.recentMessages requires chatId');
  const msgs = await getRecent(chatId, 6);
  return msgs.map((m) => ({
    role: m.role,
    text: (m.textContent ?? '').slice(0, 200),
    name: m.fullName || m.username || '?',
  }));
}

async function toolWebSearch(args: Record<string, unknown>): Promise<unknown> {
  // 与 subagent host-api 的 web.search 同源（pipeline/tools/search.ts）
  const { executeSearch } = await import('../../pipeline/tools/search.js');
  const query = String(args['query'] ?? '').slice(0, 200);
  if (!query) throw new Error('web.search requires query');
  const raw = await executeSearch(query);
  return String(raw ?? '').slice(0, 3500);
}

/**
 * 可逆写唯一实现：telegram.sendText。
 * chatId 必须显式传（intent scope），且只能发到 intent 所在群或主人 DM。
 * 真发送走 sender.sendDirect（与 pipeline 同一出口，有审计日志）。
 */
async function toolSendText(args: Record<string, unknown>, intentChatId: number | null): Promise<unknown> {
  const text = String(args['text'] ?? '').slice(0, 1000);
  if (!text.trim()) throw new Error('telegram.sendText requires text');
  const toChat = Number(args['chatId'] ?? intentChatId ?? 0);
  if (!toChat) throw new Error('telegram.sendText requires chatId');
  // scope 约束：只能发到 intent 所在群（防 intent 挪用到别的群）
  if (intentChatId !== null && toChat !== intentChatId) {
    throw new Error(`scope violation: intent chat ${intentChatId} != target ${toChat}`);
  }
  const { sender } = await import('../../pipeline/shared.js');
  const messageId = await sender.sendDirect(toChat, text);
  return { messageId };
}

const TOOLS: Record<string, ToolFn> = {
  'memory.search': toolMemorySearch,
  'chats.recentMessages': toolRecentMessages,
  'web.search': toolWebSearch,
  'telegram.sendText': toolSendText,
};

/**
 * 真执行一条 authorized_intent。
 * 前置：intent 必须 open/approved（approve 里验）；irreversible 必须 gateConfirm 过。
 * 后置：成功 → receipt（dryRun:false）+ intent consumed；失败 → receipt（ok:false）+ intent 保持（可重试一次，由调用方决定）。
 */
export async function executeIntentReal(intentId: string): Promise<RealExecuteResult> {
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
  const args = (body.args ?? {}) as Record<string, unknown>;
  const tier = classify(tool, args);

  // gate：host 侧拦截（readonly 直放；写类验 intent+确认）
  const ap = await approve(tier, intentId);
  if (!ap.ok) {
    logger.info({ intentId, tool, tier, reason: ap.reason }, 'core L2 real-execute denied by gate');
    return { executed: false, tool, tier, reason: ap.reason ?? 'denied' };
  }

  const fn = TOOLS[tool];
  if (!fn) {
    // classify 已 fail-closed（未知→irreversible），能到这里说明有 intent+确认
    // 但 L2 没有该工具的实现 → 拒（执行资格与审批资格分离）
    logger.info({ intentId, tool, tier }, 'core L2 real-execute: no implementation for tool');
    return { executed: false, tool, tier, reason: `no L2 implementation: ${tool}` };
  }

  try {
    const data = await fn(args, intent.chatId);
    const receipt = writeEntry({
      kind: 'execution_receipt',
      author: 'l2',
      content: JSON.stringify({ intent: intentId, tool, ok: true, dryRun: false }),
      chatId: intent.chatId ?? undefined,
    });
    if (receipt.ok) setEntryStatus(receipt.id!, 'consumed');
    setEntryStatus(intentId, 'consumed');
    logger.info({ intentId, tool, tier, receiptId: receipt.id }, 'core L2 real-executed');
    return { executed: true, tool, tier, receiptId: receipt.id, data };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    writeEntry({
      kind: 'execution_receipt',
      author: 'l2',
      content: JSON.stringify({ intent: intentId, tool, ok: false, dryRun: false, error: reason.slice(0, 200) }),
      chatId: intent.chatId ?? undefined,
    });
    logger.info({ intentId, tool, tier, reason }, 'core L2 real-execute tool threw');
    return { executed: false, tool, tier, reason };
  }
}
