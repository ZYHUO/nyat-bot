import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { findConversationRef, isPlatformInternalId } from './identity-store.js';
import { isConversationOwner } from './owner-context.js';

export interface OneBotAssignment {
  id: string;
  accountId: string;
  ownerId: string;
  controllerChatId: number;
  targetChatId: number;
  targetGroupId: string;
  createdAt: number;
  expiresAt: number;
  mode: 'once' | 'participate';
  maxMessages: number;
  minIntervalMs: number;
  publicText?: string;
  state: 'active' | 'stopped' | 'expired' | 'exhausted' | 'held';
  reservedMessages: number;
  acknowledgedMessages: number;
  lastSendAt?: number;
}

export interface CreateOneBotAssignmentInput {
  commandId: string;
  accountId: string;
  ownerId: string;
  controllerChatId: number;
  targetChatId: number;
  targetGroupId: string;
  /** The authenticated command event time, stable across replay. */
  createdAt: number;
  expiresAt: number;
  mode: 'once' | 'participate';
  maxMessages: number;
  minIntervalMs: number;
  publicText?: string;
}

export interface OneBotAssignmentReservation {
  id: string;
  assignmentId: string;
  taskId: string;
  chatId: number;
  count: number;
  createdAt: number;
  state: 'reserved' | 'acknowledged' | 'failed' | 'unknown';
}

export interface OneBotAssignmentReceipt {
  reservationId: string;
  taskId: string;
  chatId: number;
  state: OneBotAssignmentReservation['state'];
  bubbleIndex?: number;
  messageId?: string;
  createdAt: number;
}

export class OneBotAssignmentError extends Error {
  constructor(readonly code: string) {
    super(`OneBot assignment: ${code}`);
    this.name = 'OneBotAssignmentError';
  }
}

interface AssignmentRow {
  id: string; account_id: string; command_id: string; input_json: string; owner_id: string;
  controller_chat_id: number; target_chat_id: number; target_group_id: string;
  created_at: number; expires_at: number; mode: OneBotAssignment['mode'];
  max_messages: number; min_interval_ms: number; public_text: string | null;
  state: OneBotAssignment['state']; reserved_messages: number; acknowledged_messages: number;
  last_send_at: number | null;
}
interface TaskRow { task_id: string; assignment_id: string; chat_id: number }
interface SendRow {
  id: string; assignment_id: string; task_id: string; chat_id: number;
  bubble_count: number; created_at: number; state: OneBotAssignmentReservation['state'];
}

function refuse(code: string): never { throw new OneBotAssignmentError(code); }

/** Intent commits must survive host power loss before the external send starts. */
function durableWrite<T>(operation: (db: Database.Database) => T): T {
  const db = getDb();
  if (db.inTransaction) refuse('nested_transaction_refused');
  const previous = Number(db.pragma('synchronous', { simple: true }));
  db.pragma('synchronous = FULL');
  try { return db.transaction(() => operation(db)).immediate(); }
  finally { db.pragma(`synchronous = ${previous}`); }
}

function audit(db: Database.Database, id: string, event: string, details: Record<string, unknown> = {}): void {
  db.prepare(`INSERT INTO onebot_assignment_events (assignment_id, event_type, details_json, created_at)
    VALUES (?, ?, ?, ?)`).run(id, event, JSON.stringify(details), Date.now());
}

function row(id: string): AssignmentRow | undefined {
  return getDb().prepare('SELECT * FROM onebot_assignments WHERE id = ?').get(id) as AssignmentRow | undefined;
}
function assignment(value: AssignmentRow): OneBotAssignment {
  return {
    id: value.id, accountId: value.account_id, ownerId: value.owner_id,
    controllerChatId: value.controller_chat_id, targetChatId: value.target_chat_id,
    targetGroupId: value.target_group_id, createdAt: value.created_at, expiresAt: value.expires_at,
    mode: value.mode, maxMessages: value.max_messages, minIntervalMs: value.min_interval_ms,
    ...(value.public_text !== null ? { publicText: value.public_text } : {}),
    state: value.state === 'active' && value.expires_at <= Date.now() ? 'expired' : value.state,
    reservedMessages: value.reserved_messages, acknowledgedMessages: value.acknowledged_messages,
    ...(value.last_send_at !== null ? { lastSendAt: value.last_send_at } : {}),
  };
}
function sendRow(id: string): SendRow {
  return getDb().prepare('SELECT * FROM onebot_assignment_sends WHERE id = ?').get(id) as SendRow | undefined
    ?? refuse('reservation_not_found');
}
function taskRow(id: string): TaskRow | undefined {
  return getDb().prepare('SELECT * FROM onebot_assignment_tasks WHERE task_id = ?').get(id) as TaskRow | undefined;
}
function qqNumber(value: string): boolean {
  return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}
function allowed(raw: string, id: string): boolean {
  return raw.split(',').map((part) => part.trim()).filter(Boolean).includes(id);
}

/** Recheck platform/account identities and raw QQ allowlists at every effect boundary. */
function assertAuthority(value: OneBotAssignment): void {
  const config = env();
  if (!config.ONEBOT_ENABLED || !config.QQ_ASSIGNMENTS_ENABLED) refuse('feature_disabled');
  if (value.accountId !== config.ONEBOT_ACCOUNT_ID || value.ownerId !== config.ONEBOT_OWNER_ID) refuse('identity_changed');
  const controller = findConversationRef(value.controllerChatId);
  const target = findConversationRef(value.targetChatId);
  if (!controller || controller.platform !== 'qq' || controller.idNamespace !== 'qq-number'
    || controller.conversationKind !== 'private' || controller.threadId !== undefined
    || controller.accountId !== value.accountId || controller.id !== value.ownerId
    || !isConversationOwner(value.controllerChatId, value.controllerChatId)) refuse('controller_not_owner');
  if (!target || target.platform !== 'qq' || target.idNamespace !== 'qq-number'
    || target.conversationKind !== 'group' || target.threadId !== undefined
    || target.accountId !== value.accountId || target.id !== value.targetGroupId) refuse('target_mismatch');
  if (!allowed(config.QQ_ASSIGNMENT_GROUP_IDS, value.targetGroupId)
    || !allowed(config.ONEBOT_ALLOWED_GROUP_IDS, value.targetGroupId)) refuse('target_not_allowed');
}

function assertLive(value: OneBotAssignment, reserved = false): void {
  assertAuthority(value);
  if (value.expiresAt <= Date.now()) refuse('expired');
  if (value.state !== 'active' && !(reserved && value.state === 'exhausted')) refuse(value.state);
}

function inputJson(input: CreateOneBotAssignmentInput): string {
  // Named fields prevent object property order or accidental extra metadata affecting replay.
  return JSON.stringify([input.accountId, input.ownerId, input.controllerChatId, input.targetChatId,
    input.targetGroupId, input.createdAt, input.expiresAt, input.mode, input.maxMessages,
    input.minIntervalMs, input.publicText ?? null]);
}

export function findOneBotAssignmentByCommand(accountId: string, commandId: string): OneBotAssignment | null {
  const value = getDb().prepare('SELECT * FROM onebot_assignments WHERE account_id = ? AND command_id = ?')
    .get(accountId, commandId) as AssignmentRow | undefined;
  return value ? assignment(value) : null;
}

export function getOneBotAssignment(id: string): OneBotAssignment | null {
  const value = row(id);
  return value ? assignment(value) : null;
}

/** Metadata only; callers must authenticate the grant's controller before disclosure. */
export function readOneBotAssignmentReceipts(id: string): OneBotAssignmentReceipt[] {
  const values = getDb().prepare(`SELECT s.*, r.bubble_index, r.message_id FROM onebot_assignment_sends s
    LEFT JOIN onebot_assignment_receipts r ON r.reservation_id = s.id
    WHERE s.assignment_id = ? ORDER BY s.created_at, s.id, r.bubble_index`).all(id) as
    (SendRow & { bubble_index: number | null; message_id: string | null })[];
  return values.map((value) => ({ reservationId: value.id, taskId: value.task_id, chatId: value.chat_id,
    state: value.state, createdAt: value.created_at,
    ...(value.bubble_index !== null ? { bubbleIndex: value.bubble_index } : {}),
    ...(value.message_id !== null ? { messageId: value.message_id } : {}),
  }));
}

export function createOneBotAssignment(input: CreateOneBotAssignmentInput): { assignment: OneBotAssignment; duplicate: boolean } {
  if (!input.commandId.trim() || input.commandId.length > 512 || !qqNumber(input.accountId)
    || !qqNumber(input.ownerId) || input.accountId === input.ownerId || !qqNumber(input.targetGroupId)
    || !Number.isSafeInteger(input.controllerChatId) || !Number.isSafeInteger(input.targetChatId)
    || !isPlatformInternalId(input.controllerChatId) || !isPlatformInternalId(input.targetChatId)) refuse('invalid_identity');
  if (!Number.isSafeInteger(input.createdAt) || !Number.isSafeInteger(input.expiresAt)
    || input.expiresAt <= input.createdAt || input.expiresAt - input.createdAt > 30 * 60_000
    || input.createdAt > Date.now() + 30_000) refuse('invalid_deadline');
  if ((input.mode !== 'once' && input.mode !== 'participate')
    || !Number.isSafeInteger(input.maxMessages) || input.maxMessages < 1 || input.maxMessages > 5
    || (input.mode === 'once' && input.maxMessages !== 1)
    || !Number.isSafeInteger(input.minIntervalMs) || input.minIntervalMs < 30_000
    || (input.publicText !== undefined && (!input.publicText.trim() || input.publicText.length > 2000))) refuse('invalid_limits');
  return durableWrite((db) => {
    const existing = db.prepare('SELECT * FROM onebot_assignments WHERE account_id = ? AND command_id = ?')
      .get(input.accountId, input.commandId) as AssignmentRow | undefined;
    if (existing) {
      if (existing.input_json !== inputJson(input)) refuse('command_replay_mismatch');
      return { assignment: assignment(existing), duplicate: true };
    }
    const value: OneBotAssignment = { ...input, id: randomUUID(), state: 'active', reservedMessages: 0, acknowledgedMessages: 0 };
    assertLive(value);
    db.prepare("UPDATE onebot_assignments SET state = 'expired' WHERE state = 'active' AND expires_at <= ?").run(Date.now());
    if (input.mode === 'participate' && db.prepare(`SELECT id FROM onebot_assignments
      WHERE account_id = ? AND target_chat_id = ? AND mode = 'participate' AND state = 'active'`)
      .get(input.accountId, input.targetChatId)) refuse('active_assignment_exists');
    db.prepare(`INSERT INTO onebot_assignments (id, account_id, command_id, input_json, owner_id, controller_chat_id,
      target_chat_id, target_group_id, created_at, expires_at, mode, max_messages, min_interval_ms, public_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(value.id, input.accountId, input.commandId,
      inputJson(input), input.ownerId, input.controllerChatId, input.targetChatId, input.targetGroupId,
      input.createdAt, input.expiresAt, input.mode, input.maxMessages, input.minIntervalMs, input.publicText ?? null);
    audit(db, value.id, 'created', { commandId: input.commandId, controllerChatId: input.controllerChatId });
    return { assignment: assignment(row(value.id) ?? refuse('assignment_not_found')), duplicate: false };
  });
}

export function activeOneBotAssignment(chatId: number): OneBotAssignment | null {
  if (!env().QQ_ASSIGNMENTS_ENABLED || !isPlatformInternalId(chatId) || chatId >= 0) return null;
  const values = getDb().prepare(`SELECT * FROM onebot_assignments WHERE target_chat_id = ?
    AND mode = 'participate' AND state = 'active' AND expires_at > ? ORDER BY created_at DESC`).all(chatId, Date.now()) as AssignmentRow[];
  for (const value of values) {
    try { const result = assignment(value); assertLive(result); return result; }
    catch (error) { if (!(error instanceof OneBotAssignmentError)) throw error; }
  }
  return null;
}

/** Only the authenticated private owner controller may stop by public grant ID. */
export function stopOneBotAssignment(id: string, controllerChatId: number): OneBotAssignment {
  return durableWrite((db) => {
    const value = getOneBotAssignment(id) ?? refuse('assignment_not_found');
    if (value.controllerChatId !== controllerChatId) refuse('controller_not_owner');
    // Revocation remains available after allowlist removal or disabling the feature.
    const controller = findConversationRef(controllerChatId);
    if (!controller || controller.platform !== 'qq' || controller.idNamespace !== 'qq-number'
      || controller.conversationKind !== 'private' || controller.id !== value.ownerId
      || controller.accountId !== value.accountId || value.accountId !== env().ONEBOT_ACCOUNT_ID
      || value.ownerId !== env().ONEBOT_OWNER_ID || !isConversationOwner(controllerChatId, controllerChatId)) refuse('controller_not_owner');
    if (value.state !== 'stopped') {
      db.prepare("UPDATE onebot_assignments SET state = 'stopped' WHERE id = ?").run(id);
      audit(db, id, 'stopped', { controllerChatId });
    }
    return { ...value, state: 'stopped' };
  });
}

/** Host ingress only: a group's explicit stop signal can revoke, never grant, authority. */
export function stopOneBotAssignmentsForChat(chatId: number): number {
  if (!isPlatformInternalId(chatId) || chatId >= 0) return 0;
  return durableWrite((db) => {
    const values = db.prepare(`SELECT id FROM onebot_assignments WHERE target_chat_id = ?
      AND state IN ('active', 'exhausted', 'held')`).all(chatId) as { id: string }[];
    for (const value of values) {
      db.prepare("UPDATE onebot_assignments SET state = 'stopped' WHERE id = ?").run(value.id);
      audit(db, value.id, 'group_stopped', { chatId });
    }
    return values.length;
  });
}

export function bindOneBotAssignmentTask(id: string, taskId: string, chatId: number): void {
  if (!taskId.trim() || taskId.length > 512) refuse('invalid_task');
  durableWrite((db) => {
    const value = getOneBotAssignment(id) ?? refuse('assignment_not_found');
    if (value.targetChatId !== chatId) refuse('target_mismatch');
    assertLive(value);
    const existing = taskRow(taskId);
    if (existing) {
      if (existing.assignment_id !== id || existing.chat_id !== chatId) refuse('task_binding_mismatch');
      return;
    }
    db.prepare('INSERT INTO onebot_assignment_tasks (task_id, assignment_id, chat_id, created_at) VALUES (?, ?, ?, ?)')
      .run(taskId, id, chatId, Date.now());
    audit(db, id, 'task_bound', { taskId });
  });
}

export function assertOneBotAssignmentTask(
  task: { id: string; chatId: number; qqAssignmentId?: string },
  options: { executionStart?: boolean } = {},
): OneBotAssignment | null {
  const binding = taskRow(task.id);
  if (!binding && !task.qqAssignmentId) return null;
  if (!binding || binding.assignment_id !== task.qqAssignmentId || binding.chat_id !== task.chatId) refuse('task_binding_mismatch');
  const value = getOneBotAssignment(binding.assignment_id) ?? refuse('assignment_not_found');
  if (value.targetChatId !== task.chatId) refuse('target_mismatch');
  const send = getDb().prepare('SELECT * FROM onebot_assignment_sends WHERE task_id = ?').get(task.id) as SendRow | undefined;
  if (options.executionStart && send) {
    refuse(send.state === 'reserved' || send.state === 'unknown' ? 'pending_reservation' : 'send_already_reserved');
  }
  assertLive(value, send?.state === 'reserved');
  return value;
}

export function reserveOneBotAssignmentSend(taskId: string, chatId: number, count: number): OneBotAssignmentReservation {
  if (!Number.isSafeInteger(count) || count < 1 || count > 5) refuse('invalid_bubble_count');
  return durableWrite((db) => {
    const binding = taskRow(taskId) ?? refuse('task_binding_mismatch');
    if (binding.chat_id !== chatId) refuse('target_mismatch');
    if (db.prepare('SELECT id FROM onebot_assignment_sends WHERE task_id = ?').get(taskId)) refuse('send_already_reserved');
    const value = getOneBotAssignment(binding.assignment_id) ?? refuse('assignment_not_found');
    if (value.targetChatId !== chatId) refuse('target_mismatch');
    assertLive(value);
    if (db.prepare("SELECT id FROM onebot_assignment_sends WHERE assignment_id = ? AND state IN ('reserved', 'unknown')").get(value.id)) refuse('pending_reservation');
    if (value.reservedMessages + count > value.maxMessages) refuse('budget_exceeded');
    const now = Date.now();
    if (value.lastSendAt !== undefined && now - value.lastSendAt < value.minIntervalMs) refuse('interval_not_elapsed');
    const result: OneBotAssignmentReservation = { id: randomUUID(), assignmentId: value.id, taskId, chatId, count, createdAt: now, state: 'reserved' };
    db.prepare(`INSERT INTO onebot_assignment_sends (id, assignment_id, task_id, chat_id, bubble_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(result.id, value.id, taskId, chatId, count, now);
    db.prepare(`UPDATE onebot_assignments SET reserved_messages = reserved_messages + ?, last_send_at = ?,
      state = CASE WHEN reserved_messages + ? >= max_messages THEN 'exhausted' ELSE state END WHERE id = ?`)
      .run(count, now, count, value.id);
    audit(db, value.id, 'send_reserved', { reservationId: result.id, taskId, count });
    return result;
  });
}

export function assertOneBotAssignmentReservation(reservationId: string): OneBotAssignment {
  const send = sendRow(reservationId);
  if (send.state !== 'reserved') refuse('reservation_not_pending');
  const value = getOneBotAssignment(send.assignment_id) ?? refuse('assignment_not_found');
  const binding = taskRow(send.task_id);
  if (!binding || binding.assignment_id !== value.id || binding.chat_id !== send.chat_id || send.chat_id !== value.targetChatId) refuse('task_binding_mismatch');
  assertLive(value, true);
  return value;
}

/** Record actual receipts even when revocation raced with the network response. */
export function acknowledgeOneBotAssignmentSend(reservationId: string, bubbleIndex: number, messageId: string | number): void {
  if (!Number.isSafeInteger(bubbleIndex) || bubbleIndex < 0 || typeof messageId === 'number' && !Number.isSafeInteger(messageId)
    || !String(messageId).trim() || String(messageId).length > 512) refuse('invalid_receipt');
  durableWrite((db) => {
    const send = sendRow(reservationId);
    if (bubbleIndex >= send.bubble_count) refuse('invalid_receipt');
    const receipt = db.prepare('SELECT message_id FROM onebot_assignment_receipts WHERE reservation_id = ? AND bubble_index = ?')
      .get(reservationId, bubbleIndex) as { message_id: string } | undefined;
    if (receipt) { if (receipt.message_id !== String(messageId)) refuse('receipt_mismatch'); return; }
    if (send.state !== 'reserved' && send.state !== 'unknown') refuse('reservation_not_pending');
    if (db.prepare('SELECT 1 FROM onebot_assignment_receipts WHERE assignment_id = ? AND message_id = ?')
      .get(send.assignment_id, String(messageId))) refuse('duplicate_receipt');
    db.prepare(`INSERT INTO onebot_assignment_receipts (reservation_id, assignment_id, bubble_index, message_id, acknowledged_at)
      VALUES (?, ?, ?, ?, ?)`).run(reservationId, send.assignment_id, bubbleIndex, String(messageId), Date.now());
    db.prepare(`UPDATE onebot_assignments SET acknowledged_messages = acknowledged_messages + 1,
      last_send_at = MAX(COALESCE(last_send_at, 0), ?) WHERE id = ?`).run(Date.now(), send.assignment_id);
    const count = db.prepare('SELECT COUNT(*) AS n FROM onebot_assignment_receipts WHERE reservation_id = ?')
      .get(reservationId) as { n: number };
    if (count.n === send.bubble_count) db.prepare("UPDATE onebot_assignment_sends SET state = 'acknowledged' WHERE id = ?").run(reservationId);
    audit(db, send.assignment_id, 'send_acknowledged', { reservationId, bubbleIndex, messageId: String(messageId) });
  });
}

/** Never refund consumed budget; an unknown result freezes the entire grant. */
export function failOneBotAssignmentSend(reservationId: string, unknown: boolean): void {
  durableWrite((db) => {
    const send = sendRow(reservationId);
    if (send.state === 'acknowledged' || send.state === 'unknown' || send.state === 'failed' && !unknown) return;
    db.prepare('UPDATE onebot_assignment_sends SET state = ? WHERE id = ?').run(unknown ? 'unknown' : 'failed', reservationId);
    if (unknown) db.prepare("UPDATE onebot_assignments SET state = 'held' WHERE id = ? AND state IN ('active', 'exhausted')").run(send.assignment_id);
    audit(db, send.assignment_id, unknown ? 'send_unknown' : 'send_failed', { reservationId });
  });
}
