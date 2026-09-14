// Route an already authorized, read-only blackboard intent through Agency.
//
// This is deliberately narrower than the future action adapters: it preserves
// the existing L2 tool implementations and only gives Agency ownership of the
// durable run, policy decision, budget and receipt for read actions.

import { readEntry, setEntryStatus, writeEntry } from '../core/blackboard/store.js';
import { executeReadonlyTool } from '../core/l2/execute.js';
import { classify } from '../core/permission/tiers.js';
import {
  createAgencyEnvelope,
  createAgencyRun,
  dispatchAgencyRun,
} from './agency-runtime.js';
import type { AgencyAction } from './agency.js';

export interface AgencyIntentExecuteResult {
  executed: boolean;
  tool?: string;
  tier?: string;
  agencyRunId?: string;
  receiptId?: string;
  data?: unknown;
  deferred?: boolean;
  reused?: boolean;
  agencyUnavailable?: boolean;
  reason?: string;
}

interface IntentBody {
  tool?: string;
  args?: unknown;
  why?: string;
}

function boundedJson(value: unknown, max = 500): string {
  try {
    const serialized = JSON.stringify(value);
    return (typeof serialized === 'string' ? serialized : '{}').slice(0, max);
  } catch {
    return '{}';
  }
}

function parseIntent(intentId: string): { tool: string; args: Record<string, unknown>; why: string } | { reason: string } {
  const intent = readEntry(intentId);
  if (!intent) return { reason: 'intent not found' };
  if (intent.kind !== 'authorized_intent') return { reason: 'not an intent' };
  if (intent.status !== 'open' && intent.status !== 'approved') {
    return { reason: `intent status=${intent.status}` };
  }
  let body: IntentBody;
  try {
    body = JSON.parse(intent.content) as IntentBody;
  } catch {
    return { reason: 'intent content not JSON' };
  }
  if (!body || typeof body !== 'object') return { reason: 'intent content not an object' };
  if (typeof body.args !== 'undefined'
    && (typeof body.args !== 'object' || body.args === null || Array.isArray(body.args))) {
    return { reason: 'intent args not an object' };
  }
  return {
    tool: body.tool ?? 'unknown',
    args: (body.args ?? {}) as Record<string, unknown>,
    why: typeof body.why === 'string' ? body.why.slice(0, 200) : '',
  };
}

function writeCompatibilityReceipt(
  intentId: string,
  chatId: number,
  tool: string,
  runId: string,
  ok: boolean,
  error?: string,
): string | undefined {
  // A deterministic id makes process-crash recovery idempotent across the
  // Agency success and legacy blackboard status updates.
  const id = `agency-receipt:${runId}`.slice(0, 240);
  const receipt = writeEntry({
    id,
    kind: 'execution_receipt',
    author: 'l2',
    content: JSON.stringify({
      intent: intentId,
      agencyRunId: runId,
      tool,
      ok,
      dryRun: false,
      ...(error ? { error: error.slice(0, 200) } : {}),
    }),
    chatId,
  });
  if (!receipt.ok || !receipt.id) return undefined;
  setEntryStatus(receipt.id, 'consumed');
  if (ok) setEntryStatus(intentId, 'consumed');
  return receipt.id;
}

/**
 * Dispatch one authorized read intent through the durable Agency runtime.
 * `shadow` persists a waiting run; only an explicit advisory/canary/authority
 * policy may invoke the host read adapter.
 */
export async function executeAuthorizedIntentViaAgency(intentId: string): Promise<AgencyIntentExecuteResult> {
  const intent = readEntry(intentId);
  if (!intent) return { executed: false, reason: 'intent not found' };
  if (intent.chatId === null || !Number.isSafeInteger(intent.chatId) || intent.chatId === 0) {
    return { executed: false, reason: 'scoped_chat_required' };
  }
  const parsed = parseIntent(intentId);
  if ('reason' in parsed) return { executed: false, reason: parsed.reason };
  const tier = classify(parsed.tool, parsed.args);
  if (tier !== 'readonly') {
    return { executed: false, tool: parsed.tool, tier, reason: 'Agency adapter only handles readonly intents' };
  }

  const target = `l2-read:${parsed.tool}`.slice(0, 500);
  const envelope = createAgencyEnvelope({
    action: { type: 'observe', target, args: parsed.args },
    scope: { visibility: 'chat', chatId: intent.chatId },
    idempotencyKey: `agency-intent:${intentId}`,
    correlationId: `core:intent:${intentId}`,
    expectedOutcome: boundedJson({ kind: 'l2_read_intent', intentId, tool: parsed.tool, why: parsed.why }),
    budget: { maxMs: 30_000, maxLlmCalls: 0, maxToolCalls: 1 },
  });
  if (!envelope.ok || !envelope.envelope) {
    return { executed: false, tool: parsed.tool, tier, reason: envelope.reason ?? 'invalid_envelope' };
  }

  const created = createAgencyRun(envelope.envelope);
  if (!created.ok || !created.run) {
    const reason = created.reason ?? 'agency_run_unavailable';
    return {
      executed: false,
      tool: parsed.tool,
      tier,
      agencyUnavailable: reason === 'agency_runs_unavailable' || reason === 'agency_runs_error',
      reason,
    };
  }

  const adapter = async (action: AgencyAction, context: { usage: { consumeToolCall(): number } }): Promise<unknown> => {
    if (action.type !== 'observe' || action.target !== target) throw new Error('agency read action mismatch');
    context.usage.consumeToolCall();
    return executeReadonlyTool(parsed.tool, action.args ?? {}, intent.chatId);
  };
  const dispatched = await dispatchAgencyRun(created.run.id, { observe: adapter });
  const run = dispatched.run ?? created.run;
  if (run.status === 'succeeded') {
    const receiptId = writeCompatibilityReceipt(intentId, intent.chatId, parsed.tool, run.id, true);
    return {
      executed: true,
      tool: parsed.tool,
      tier,
      agencyRunId: run.id,
      receiptId,
      data: run.result,
      reused: created.reused,
    };
  }

  if (run.status === 'failed') {
    const receiptId = writeCompatibilityReceipt(intentId, intent.chatId, parsed.tool, run.id, false, run.error ?? dispatched.reason);
    return {
      executed: false,
      tool: parsed.tool,
      tier,
      agencyRunId: run.id,
      receiptId,
      reused: created.reused,
      reason: dispatched.reason ?? run.error ?? 'agency run failed',
    };
  }
  return {
    executed: false,
    tool: parsed.tool,
    tier,
    agencyRunId: run.id,
    deferred: run.status === 'waiting',
    reused: created.reused,
    reason: dispatched.reason ?? `agency run ${run.status}`,
  };
}
