// Explicit Agency delivery adapters. The host supplies the actual sender so
// constructing these adapters never creates an external side effect by itself.

import { validateAgencyAction } from './agency.js';
import type { AgencyAction } from './agency.js';
import type { AgencyAdapter, AgencyAdapters, AgencyAdapterContext } from './agency-runtime.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';

export interface AgencyDeliveryRequest {
  chatId: number;
  scope: CognitiveScope;
  text: string;
  replyToMessageId?: number;
  runId: string;
  attempt: number;
  correlationId: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface AgencyDeliveryResult {
  messageId: number;
}

/** The pipeline or another host boundary owns transport and deduplication. */
export type AgencyDelivery = (request: AgencyDeliveryRequest) => Promise<AgencyDeliveryResult>;

function scopedChatId(context: AgencyAdapterContext): number {
  const chatId = context.scope.chatId;
  if (context.scope.visibility === 'global' || chatId === undefined || !Number.isSafeInteger(chatId) || chatId === 0) {
    throw new Error('delivery requires a scoped chat');
  }
  return chatId;
}

function checkedAction(action: AgencyAction, type: 'speak' | 'ask'): AgencyAction & { type: typeof type } {
  const checked = validateAgencyAction(action);
  if (!checked.ok || !checked.action || checked.action.type !== type) {
    throw new Error(`delivery adapter action mismatch: expected ${type}`);
  }
  return checked.action as AgencyAction & { type: typeof type };
}

function deliveryAdapter(type: 'speak' | 'ask', deliver: AgencyDelivery): AgencyAdapter {
  return async (rawAction, context) => {
    const action = checkedAction(rawAction, type);
    const chatId = scopedChatId(context);
    if (context.signal.aborted) throw new Error('agency run cancelled');

    context.usage.consumeToolCall();
    const result = await deliver({
      chatId,
      scope: context.scope,
      text: action.type === 'speak' ? action.text : action.question,
      ...(action.replyToMessageId !== undefined ? { replyToMessageId: action.replyToMessageId } : {}),
      runId: context.runId,
      attempt: context.attempt,
      correlationId: context.correlationId,
      idempotencyKey: context.idempotencyKey,
      signal: context.signal,
    });
    if (!result || typeof result !== 'object' || !Number.isSafeInteger(result.messageId) || result.messageId <= 0) {
      throw new Error('invalid delivery receipt');
    }
    return { messageId: result.messageId };
  };
}

/** Build the explicit speak/ask adapter pair for a caller-owned transport. */
export function createAgencyDeliveryAdapters(deliver: AgencyDelivery): Pick<AgencyAdapters, 'speak' | 'ask'> {
  return {
    speak: deliveryAdapter('speak', deliver),
    ask: deliveryAdapter('ask', deliver),
  };
}

/**
 * Bind the explicit delivery contract to the existing Telegram sender.
 * Importing this factory is side-effect free; a caller must still pass the
 * returned adapters to `dispatchAgencyRun` under an allowed Agency policy.
 */
export function createTelegramAgencyDeliveryAdapters(): Pick<AgencyAdapters, 'speak' | 'ask'> {
  return createAgencyDeliveryAdapters(async ({ chatId, text, replyToMessageId }) => {
    const { sender } = await import('../pipeline/shared.js');
    return sender.sendDirect(chatId, text, replyToMessageId);
  });
}
