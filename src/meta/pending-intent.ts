import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { getDb } from '../db/sqlite.js';
import { eventHash, canonicalJson } from '../shared/event-identity.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { isOneBotMessageRecalled } from '../platform/onebot-notices.js';
import { isHardStop } from '../agent/interrupts.js';
import { findConversationRef, isPlatformInternalId } from '../platform/identity-store.js';
import { getBotIdentity } from '../bot/bot.js';
import type { FormattedMessage } from '../shared/types.js';

/** A snapshot of the input revision used to generate a draft. Never refresh it
 * from current state at send time: that would bless an already obsolete draft. */
export interface PendingIntentRef {
  laneKey: string;
  intentId: string;
  revision: number;
  platform: 'telegram' | 'qq';
  accountId: string;
  chatId: number;
  senderId: number;
  threadId: number;
  inputControl?: 'hold' | 'release' | 'cancel';
}
type IntentState = 'pending' | 'held' | 'cancelled' | 'settled';
interface LaneRow {
  lane_key: string; intent_id: string; platform: 'telegram' | 'qq'; account_id: string;
  chat_id: number; sender_id: number; thread_id: number; revision: number;
  state: IntentState; first_at: number; changed_at: number; confirmed_revision: number;
}
interface SourceRow {
  lane_key: string; intent_id: string; sender_id: number; source_revision: string;
  edited_at: number | null; received_at: number;
}
const snapshot = (row: LaneRow): PendingIntentRef => ({ laneKey: row.lane_key, intentId: row.intent_id,
  revision: row.revision, platform: row.platform, accountId: row.account_id, chatId: row.chat_id,
  senderId: row.sender_id, threadId: row.thread_id });
export const pendingIntentEnabled = (): boolean => env().META_PENDING_INTENT_ENABLED === true;

export function pendingInputControl(text: string, aliases: readonly string[] = []): 'hold' | 'release' | 'cancel' | null {
  let value = text.trim();
  for (const alias of aliases) {
    const prefix = value.startsWith('@') ? `@${alias}` : alias;
    if (alias && value.startsWith(prefix) && /^[\s，,:：]/u.test(value.slice(prefix.length, prefix.length + 1))) {
      value = value.slice(prefix.length).replace(/^[\s，,:：]+/u, ''); break;
    }
  }
  value = value.replace(/[。！!～~]$/u, '');
  if (value.length > 60) return null;
  if (/^(?:先别(?:回|回复|回答)|(?:请)?等我(?:发|贴|说|写)完(?:再(?:回|回复|说|回答))?|我还没(?:发|贴|说)完)$/u.test(value)) return 'hold';
  if (/^(?:(?:我)?(?:发|贴|说|写)完了|好了|可以(?:回|回复|回答)了)$/u.test(value)) return 'release';
  if (isHardStop(value) || /^(?:不用回了?|别回了|当我没说)$/u.test(value)) return 'cancel';
  return null;
}

/** Called only at authenticated intake, before asynchronous Heart/media work. */
export function observePendingIntent(chatId: number, message: FormattedMessage): PendingIntentRef | undefined {
  if (!pendingIntentEnabled() || message.role !== 'user' || message.isBot || message.isAnonymous) return;
  const source = message.eventIdentity, scope = resolveConversationScope(chatId);
  if (!source || !scope?.accountId || !Number.isSafeInteger(message.uid) || message.uid <= 0
    || scope.platform !== source.ref.conversation.platform || scope.accountId !== source.ref.conversation.accountId
    || scope.conversationKind !== source.ref.conversation.conversationKind) return;
  if (scope.platform === 'qq' && scope.accountId !== env().ONEBOT_ACCOUNT_ID) return;
  const threadId = message.messageThreadId ?? 0;
  const rawChat = isPlatformInternalId(chatId) ? findConversationRef(chatId)?.id : String(chatId);
  if (source.ref.conversation.id !== rawChat || Number(source.ref.conversation.threadId ?? 0) !== threadId) return;
  const laneKey = eventHash(canonicalJson([scope.platform, scope.accountId, chatId, message.uid, threadId]));
  const db = getDb();
  return db.transaction(() => {
    const duplicate = pendingIntentForEvent(source.eventId);
    if (duplicate) return duplicate;
    const previousSource = db.prepare('SELECT * FROM pending_reply_sources WHERE source_key=?').get(source.messageKey) as SourceRow | undefined;
    let row = db.prepare('SELECT * FROM pending_reply_intents WHERE lane_key=?').get(laneKey) as LaneRow | undefined;
    const retire = (current: LaneRow): void => {
      db.prepare('INSERT OR IGNORE INTO pending_reply_retired VALUES (?,?,?)').run(current.intent_id,
        current.state === 'cancelled' || current.state === 'settled' ? current.state : 'superseded', source.receivedAt);
    };
    if (previousSource) {
      // Editing a source cannot change its author/lane, revive an old cancelled
      // intent, or roll a newer edit back to an original/older platform event.
      if (previousSource.lane_key !== laneKey || previousSource.sender_id !== message.uid
        || !row
        || (source.revision === 'original' && previousSource.source_revision !== 'original')
        || (previousSource.edited_at !== null && (source.editedAt === null || source.editedAt < previousSource.edited_at))
        || (source.editedAt === previousSource.edited_at && source.receivedAt < previousSource.received_at)) return;
      const previousState = row.intent_id === previousSource.intent_id ? row.state
        : (db.prepare('SELECT state FROM pending_reply_retired WHERE intent_id=?').get(previousSource.intent_id) as { state: string } | undefined)?.state;
      if (!previousState || previousState === 'cancelled') return;
      if (row.intent_id !== previousSource.intent_id || row.state === 'settled') {
        // A genuine later edit of an answered source is new input. It starts a
        // fresh generation and never edits the old delivery/ACK history. An edit
        // of an older topic explicitly becomes this author's latest lane input.
        if (source.revision === 'original') return;
        retire(row); row = undefined;
      }
    }
    const now = source.receivedAt;
    if (!row || row.state === 'cancelled' || row.state === 'settled') {
      if (row) retire(row);
      row = { lane_key: laneKey, intent_id: randomUUID(), platform: scope.platform, account_id: scope.accountId!,
        chat_id: chatId, sender_id: message.uid, thread_id: threadId, revision: 0, state: 'pending',
        first_at: now, changed_at: now, confirmed_revision: 0 };
    }
    let aliases: string[] = [];
    try { const bot = getBotIdentity(chatId); aliases = [bot.username, ...(bot.nicknames ?? [])].filter((name): name is string => !!name); } catch { /* no inferred identities */ }
    const control = pendingInputControl(message.textContent || message.captionContent || '', aliases);
    const wasHeld = row.state === 'held';
    row.revision++;
    row.changed_at = now;
    if (control === 'hold') row.state = 'held';
    else if (control === 'cancel') row.state = 'cancelled';
    else if (control === 'release' && row.state === 'held') row.state = 'pending';
    const binding = snapshot(row);
    if (control && (control !== 'release' || wasHeld)) binding.inputControl = control;
    db.prepare(`INSERT INTO pending_reply_intents VALUES (@lane_key,@intent_id,@platform,@account_id,@chat_id,@sender_id,@thread_id,@revision,@state,@first_at,@changed_at,@confirmed_revision)
      ON CONFLICT(lane_key) DO UPDATE SET intent_id=excluded.intent_id, revision=excluded.revision, state=excluded.state,
      first_at=excluded.first_at, changed_at=excluded.changed_at, confirmed_revision=excluded.confirmed_revision`).run(row);
    db.prepare(`INSERT INTO pending_reply_sources VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET
      intent_id=excluded.intent_id, event_id=excluded.event_id, source_revision=excluded.source_revision, edited_at=excluded.edited_at,
      received_at=excluded.received_at, intent_revision=excluded.intent_revision`).run(source.messageKey, laneKey, row.intent_id,
      message.messageId, message.uid, source.eventId, source.revision, source.editedAt, now, row.revision);
    db.prepare('INSERT INTO pending_reply_events VALUES (?,?)').run(source.eventId, JSON.stringify(binding));
    return binding;
  })();
}

export function pendingIntentForEvent(eventId: string | undefined): PendingIntentRef | undefined {
  if (!pendingIntentEnabled() || !eventId) return;
  const row = getDb().prepare('SELECT binding_json FROM pending_reply_events WHERE event_id=?').get(eventId) as { binding_json: string } | undefined;
  return row ? JSON.parse(row.binding_json) as PendingIntentRef : undefined;
}

export function inspectPendingIntent(ref: PendingIntentRef): { state: IntentState | 'stale'; currentRevision: number; firstAt: number; changedAt: number } {
  const scope = resolveConversationScope(ref.chatId);
  const row = getDb().prepare('SELECT * FROM pending_reply_intents WHERE lane_key=?').get(ref.laneKey) as LaneRow | undefined;
  if (!row || !scope?.accountId || scope.platform !== ref.platform || scope.accountId !== ref.accountId
    || (scope.platform === 'qq' && scope.accountId !== env().ONEBOT_ACCOUNT_ID)
    || row.intent_id !== ref.intentId || row.chat_id !== ref.chatId || row.sender_id !== ref.senderId
    || row.thread_id !== ref.threadId || row.platform !== ref.platform || row.account_id !== ref.accountId
    || ref.revision > row.revision) return { state: 'stale', currentRevision: -1, firstAt: 0, changedAt: 0 };
  return { state: row.state, currentRevision: row.revision, firstAt: row.first_at, changedAt: row.changed_at };
}

export function assertPendingIntentCurrent(ref: PendingIntentRef | undefined): void {
  if (!pendingIntentEnabled() || !ref) return;
  const state = inspectPendingIntent(ref);
  if (state.state !== 'pending' || state.currentRevision !== ref.revision) throw new Error('pending_intent_changed');
  const ids = getDb().prepare('SELECT message_id FROM pending_reply_sources WHERE intent_id=?').all(ref.intentId) as Array<{ message_id: number }>;
  if (ids.some(item => isOneBotMessageRecalled(ref.chatId, item.message_id))) throw new Error('pending_intent_recalled');
}

export function assertInputBatchCurrent(messages: readonly FormattedMessage[]): void {
  if (!pendingIntentEnabled()) return;
  const latest = new Map<string, PendingIntentRef>();
  for (const message of messages) {
    const ref = message.pendingIntent;
    if (ref && ref.revision > (latest.get(ref.laneKey)?.revision ?? 0)) latest.set(ref.laneKey, ref);
  }
  for (const ref of latest.values()) assertPendingIntentCurrent(ref);
}

/** Message-ID answered markers predate edits. A genuine newer source revision
 * remains actionable even if an older draft already acknowledged that ID. */
export function hasUnansweredIntentRevision(ref: PendingIntentRef | undefined): boolean {
  if (!pendingIntentEnabled() || !ref) return false;
  const state = inspectPendingIntent(ref);
  if (state.state !== 'pending' && state.state !== 'held') return false;
  const row = getDb().prepare('SELECT confirmed_revision FROM pending_reply_intents WHERE lane_key=? AND intent_id=?')
    .get(ref.laneKey, ref.intentId) as { confirmed_revision: number } | undefined;
  return !!row && ref.revision > row.confirmed_revision;
}

/** Record real ACKs without changing the input revision. A late ACK still
 * exists, but may not settle the user's newer instruction. */
export function confirmPendingIntent(ref: PendingIntentRef | undefined): void {
  if (!pendingIntentEnabled() || !ref) return;
  getDb().prepare(`UPDATE pending_reply_intents SET confirmed_revision=MAX(confirmed_revision,?) WHERE lane_key=? AND intent_id=?`)
    .run(ref.revision, ref.laneKey, ref.intentId);
}
export function settlePendingIntent(ref: PendingIntentRef | undefined): void {
  if (!pendingIntentEnabled() || !ref) return;
  getDb().prepare(`UPDATE pending_reply_intents SET state='settled' WHERE lane_key=? AND intent_id=? AND revision=? AND state='pending'`)
    .run(ref.laneKey, ref.intentId, ref.revision);
}

/** Commands from other people remain context; only the target controls a task. */
export function isTaskInputAuthor(task: { chatId: number; targetUserId?: number; messageThreadId?: number },
  input: { chatId: number; userId?: number; messageThreadId?: number }): boolean {
  return task.chatId === input.chatId && task.targetUserId !== undefined && task.targetUserId === input.userId
    && (task.messageThreadId ?? 0) === (input.messageThreadId ?? 0);
}
