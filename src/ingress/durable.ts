import { AsyncLocalStorage } from 'node:async_hooks';
import type { Bot, MiddlewareFn } from 'grammy';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { createMessageEventIdentity } from '../shared/event-identity.js';
import type { MessageEventIdentity } from '../shared/event-identity.js';
import type { UpdateLike } from '../shared/types.js';
import { fromTelegramChatId } from '../platform/identity.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { findConversationRef, isPlatformInternalId } from '../platform/identity-store.js';
import { acceptInbox, claimInbox, expireInboxClaims, getInboxEntry, holdPendingInbox, listPendingInbox, renewInboxClaim, settleInbox } from './inbox-store.js';
import type { InboxEntry, InboxLane } from './inbox-store.js';

const context = new AsyncLocalStorage<MessageEventIdentity>();
export const currentIngressIdentity = (): MessageEventIdentity | undefined => context.getStore();
export class IngressNotAcceptedError extends Error {
  constructor() { super('durable_ingress_unavailable'); this.name = 'IngressNotAcceptedError'; }
}
/** grammY marks lastTriedUpdateId before middleware. Neither swallowing the
 * error nor stop()/restart on the same Bot is safe: both can confirm its offset.
 * A fresh process must fetch the unconfirmed event again. */
export function installDurablePollingErrorHandler(bot: Bot, fallback: Parameters<Bot['catch']>[0],
  terminate: (code: number) => never = code => process.exit(code)): void {
  bot.catch(err => {
    if (err.error instanceof IngressNotAcceptedError) {
      logger.error({ code: 'ingress_not_accepted' }, 'Input storage unavailable; exiting without confirming polling offset');
      return terminate(1);
    }
    return fallback(err);
  });
}
export function telegramEventIdentity(update: UpdateLike, accountId: string): MessageEventIdentity | null {
  const msg = (update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post) as
    { message_id?: number; chat?: { id?: number }; message_thread_id?: number; date?: number; edit_date?: number } | undefined;
  if (!msg?.chat?.id || !msg.message_id || isPlatformInternalId(msg.chat.id)) return null;
  return createMessageEventIdentity({ ref: { conversation: fromTelegramChatId(accountId, msg.chat.id, msg.message_thread_id || undefined), id: String(msg.message_id) },
    occurredAt: msg.date ? msg.date * 1000 : null, editedAt: msg.edit_date ? msg.edit_date * 1000 : null,
    edit: !!(update.edited_message ?? update.edited_channel_post), updateId: update.update_id, content: msg });
}
export function isCurrentInboxScope(entry: InboxEntry): boolean {
  const source = resolveConversationScope(entry.chatId), ref = entry.identity.ref.conversation;
  const sameScope = !!source?.accountId && source.platform === ref.platform && source.accountId === ref.accountId
    && source.conversationKind === ref.conversationKind
    && (source.platform !== 'qq' || (env().ONEBOT_ENABLED && env().ONEBOT_ACCOUNT_ID === source.accountId));
  if (!sameScope) return false;
  if (ref.platform === 'telegram') return ref.idNamespace === 'telegram' && ref.id === String(entry.chatId);
  const mapped = findConversationRef(entry.chatId);
  if (!mapped || mapped.id !== ref.id || mapped.idNamespace !== ref.idNamespace) return false;
  const configured = ref.conversationKind === 'group' ? env().ONEBOT_ALLOWED_GROUP_IDS : env().ONEBOT_ALLOWED_USER_IDS;
  const allowed = String(configured ?? '').split(',').map(id => id.trim()).filter(Boolean);
  return (!allowed.length || allowed.includes(ref.id))
    && !(entry.identity.occurredAt !== null && entry.identity.occurredAt < (env().META_ACTIVATED_AT_SEC ?? 0) * 1000);
}
/** Full body first; only pending (never started) may enter the handler. */
export async function runDurableIngress(input: { lane: 'telegram' | 'onebot'; chatId: number; identity: MessageEventIdentity; payload: unknown },
  handler: (identity: MessageEventIdentity, acceptedPayload: unknown) => Promise<void>): Promise<void> {
  let accepted: InboxEntry;
  try { accepted = acceptInbox(input); } catch { throw new IngressNotAcceptedError(); }
  if (accepted.state !== 'pending') {
    logger.debug({ eventId: accepted.eventId, state: accepted.state }, 'Durable ingress duplicate retained');
    return;
  }
  // Once accepted, failure is not permission for platform redelivery to replay
  // potentially side-effecting code. The recorded state, not an HTTP retry, owns recovery.
  try {
    if (!isCurrentInboxScope(accepted)) { holdPendingInbox(accepted.eventId, 'account_or_scope_changed'); return; }
    const claim = claimInbox(accepted.eventId);
    if (!claim) return;
    const identity = getInboxEntry(accepted.eventId)!.identity;
    const timer = setInterval(() => {
      try { renewInboxClaim(claim); } catch { /* expiry holds; never transfers execution ownership */ }
    }, 10_000); timer.unref?.();
    try {
      await context.run(identity, () => handler(identity, accepted.payload));
      settleInbox(claim, 'handler_returned');
    } catch {
      settleInbox(claim, 'unknown', 'handler_failed_after_accept');
      logger.warn({ eventId: accepted.eventId, chatId: accepted.chatId }, 'Accepted ingress held after handler failure');
    } finally { clearInterval(timer); }
  } catch {
    logger.warn({ eventId: accepted.eventId, chatId: accepted.chatId }, 'Accepted ingress state unavailable; no blind replay');
  }
}
/** Register AFTER authorization and BEFORE commands so unauthorized bodies are not stored. */
export function durableTelegramMiddleware(): MiddlewareFn {
  return async (ctx, next) => {
    delete (ctx.update as UpdateLike).__nyatEventIdentity;
    if (!env().DURABLE_INGRESS_ENABLED) return next();
    const accountId = resolveConversationScope(ctx.chat?.id ?? 0)?.accountId;
    // Non-message updates remain owned by their existing handlers.
    if (!(ctx.update.message ?? ctx.update.edited_message ?? ctx.update.channel_post ?? ctx.update.edited_channel_post)) return next();
    if (!accountId) throw new IngressNotAcceptedError();
    const identity = telegramEventIdentity(ctx.update, accountId);
    if (!identity || !ctx.chat) throw new IngressNotAcceptedError();
    await runDurableIngress({ lane: 'telegram', chatId: ctx.chat.id, identity, payload: ctx.update }, async (source, acceptedPayload) => {
      // Context getters read update dynamically. A pending duplicate must process
      // the first accepted body, not refreshed text/commands from a retransmission.
      const target = ctx.update as unknown as Record<string, unknown>;
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, acceptedPayload);
      (ctx.update as UpdateLike).__nyatEventIdentity = source;
      await next();
    });
  };
}

/** Independent page cursors prevent one permanently disallowed chat starving later input. */
export function startInboxRecovery(lane: Exclude<InboxLane, 'qq_heart'>,
  replay: (entry: InboxEntry) => Promise<void>, ready: () => boolean = () => true): () => Promise<void> {
  if (!env().DURABLE_INGRESS_ENABLED) return async () => {};
  let stopped = false, busy = false, cursor = 0;
  let running: Promise<void> | undefined;
  const tick = async (): Promise<void> => {
    if (stopped || busy || !ready()) return;
    busy = true;
    try {
      expireInboxClaims();
      const page = listPendingInbox(lane, cursor, 32);
      if (!page.length) { cursor = 0; return; }
      for (const entry of page) {
        if (stopped || !ready()) break;
        cursor = entry.sequence;
        if (!isCurrentInboxScope(entry)) { holdPendingInbox(entry.eventId, 'account_or_scope_changed'); continue; }
        await replay(entry);
      }
    } catch { logger.warn({ lane }, 'Durable ingress recovery unavailable'); }
    finally { busy = false; }
  };
  const timer = setInterval(() => { if (!busy) running = tick(); }, 1000); timer.unref?.();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
