import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateOneBotAssignmentInput } from '../../../src/platform/onebot-assignment-store.js';

const mocks = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
  config: {
    ONEBOT_ENABLED: true, QQ_ASSIGNMENTS_ENABLED: true, ONEBOT_ACCOUNT_ID: '80001',
    ONEBOT_OWNER_ID: '70001', ONEBOT_ALLOWED_GROUP_IDS: '50001,50002', QQ_ASSIGNMENT_GROUP_IDS: '50001,50002',
  },
}));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => mocks.db! }));
vi.mock('../../../src/env.js', () => ({ env: () => mocks.config }));

import { getOrCreateConversationId } from '../../../src/platform/identity-store.js';
import {
  acknowledgeOneBotAssignmentSend, activeOneBotAssignment, assertOneBotAssignmentReservation,
  assertOneBotAssignmentTask, bindOneBotAssignmentTask, createOneBotAssignment, failOneBotAssignmentSend,
  findOneBotAssignmentByCommand, getOneBotAssignment, readOneBotAssignmentReceipts,
  reserveOneBotAssignmentSend, stopOneBotAssignment, stopOneBotAssignmentsForChat,
} from '../../../src/platform/onebot-assignment-store.js';

const NOW = 1_800_000_000_000;
const migration = readFileSync('migrations/0134_onebot_assignments.sql', 'utf8');
const identityMigration = readFileSync('migrations/0118_platform_identity.sql', 'utf8');
let controllerChatId: number;
let targetChatId: number;
let otherChatId: number;
let directory: string;
let filename: string;

function input(overrides: Partial<CreateOneBotAssignmentInput> = {}): CreateOneBotAssignmentInput {
  return { commandId: 'event-101', accountId: '80001', ownerId: '70001', controllerChatId,
    targetChatId, targetGroupId: '50001', createdAt: NOW, expiresAt: NOW + 600_000,
    mode: 'participate', maxMessages: 5, minIntervalMs: 30_000, ...overrides };
}
function grant(overrides: Partial<CreateOneBotAssignmentInput> = {}) {
  return createOneBotAssignment(input(overrides)).assignment;
}
function bind(id: string, taskId = 'task-1', chatId = targetChatId) {
  bindOneBotAssignmentTask(id, taskId, chatId);
  return { id: taskId, chatId, qqAssignmentId: id };
}
function openDatabase() {
  mocks.db = new Database(filename);
  mocks.db.pragma('foreign_keys = ON');
  mocks.db.pragma('journal_mode = WAL');
  mocks.db.pragma('synchronous = NORMAL');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.assign(mocks.config, { ONEBOT_ENABLED: true, QQ_ASSIGNMENTS_ENABLED: true, ONEBOT_ACCOUNT_ID: '80001',
    ONEBOT_OWNER_ID: '70001', ONEBOT_ALLOWED_GROUP_IDS: '50001,50002', QQ_ASSIGNMENT_GROUP_IDS: '50001,50002' });
  directory = mkdtempSync(join(tmpdir(), 'nyat-qq-assignment-'));
  filename = join(directory, 'test.sqlite');
  openDatabase();
  mocks.db!.exec(identityMigration);
  mocks.db!.exec(migration);
  const account = { platform: 'qq', idNamespace: 'qq-number', accountId: '80001' } as const;
  controllerChatId = getOrCreateConversationId({ ...account, conversationKind: 'private', id: '70001' });
  targetChatId = getOrCreateConversationId({ ...account, conversationKind: 'group', id: '50001' });
  otherChatId = getOrCreateConversationId({ ...account, conversationKind: 'group', id: '50002' });
});
afterEach(() => {
  mocks.db?.close();
  mocks.db = undefined;
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('durable bounded QQ assignments', () => {
  it('applies the real migration idempotently and deduplicates the immutable account command', () => {
    mocks.db!.exec(migration);
    const original = createOneBotAssignment(input());
    vi.setSystemTime(NOW + 1000);
    expect(createOneBotAssignment(input())).toEqual({ assignment: original.assignment, duplicate: true });
    expect(findOneBotAssignmentByCommand('80001', 'event-101')).toEqual(original.assignment);
    expect(findOneBotAssignmentByCommand('80002', 'event-101')).toBeNull();
    expect(() => createOneBotAssignment(input({ publicText: 'changed request' }))).toThrow('command_replay_mismatch');
    expect(mocks.db!.prepare('SELECT COUNT(*) AS n FROM onebot_assignments').get()).toEqual({ n: 1 });
    expect(mocks.db!.pragma('synchronous', { simple: true })).toBe(1);
  });

  it('never revives a stopped or expired command replay', () => {
    const value = grant();
    stopOneBotAssignment(value.id, controllerChatId);
    expect(createOneBotAssignment(input())).toMatchObject({ duplicate: true, assignment: { state: 'stopped' } });
    const next = grant({ commandId: 'event-102' });
    vi.setSystemTime(NOW + 600_001);
    expect(createOneBotAssignment(input({ commandId: 'event-102' }))).toMatchObject({ duplicate: true, assignment: { id: next.id, state: 'expired' } });
    expect(activeOneBotAssignment(targetChatId)).toBeNull();
  });

  it.each([
    { maxMessages: 6 }, { mode: 'once' as const, maxMessages: 2 }, { minIntervalMs: 29_999 },
    { expiresAt: NOW + 1_800_001 }, { expiresAt: NOW }, { createdAt: NOW + 30_001 },
    { targetGroupId: '050001' }, { controllerChatId: 7 }, { publicText: ' ' },
  ])('refuses out-of-bounds grant %j', (change) => {
    expect(() => grant(change)).toThrow();
    expect(mocks.db!.prepare('SELECT COUNT(*) AS n FROM onebot_assignments').get()).toEqual({ n: 0 });
  });

  it('supports a context-only once grant with exactly one message budget', () => {
    const value = grant({ mode: 'once', maxMessages: 1 });
    const task = bind(value.id);
    expect(() => reserveOneBotAssignmentSend(task.id, task.chatId, 2)).toThrow('budget_exceeded');
    const reservation = reserveOneBotAssignmentSend(task.id, task.chatId, 1);
    expect(getOneBotAssignment(value.id)?.state).toBe('exhausted');
    expect(assertOneBotAssignmentTask(task)?.id).toBe(value.id);
    expect(assertOneBotAssignmentReservation(reservation.id).id).toBe(value.id);
  });

  it('requires current owner private identity, exact QQ target and both explicit allowlists', () => {
    const stranger = getOrCreateConversationId({ platform: 'qq', idNamespace: 'qq-number', accountId: '80001', conversationKind: 'private', id: '70002' });
    expect(() => grant({ controllerChatId: stranger })).toThrow('controller_not_owner');
    expect(() => grant({ targetChatId: otherChatId })).toThrow('target_mismatch');
    for (const flag of ['QQ_ASSIGNMENT_GROUP_IDS', 'ONEBOT_ALLOWED_GROUP_IDS'] as const) {
      mocks.config[flag] = '';
      expect(() => grant()).toThrow('target_not_allowed');
      mocks.config[flag] = '50001,50002';
    }
    mocks.config.QQ_ASSIGNMENTS_ENABLED = false;
    expect(() => grant()).toThrow('feature_disabled');
  });

  it('keeps one active participation per target and permits a new one after expiry', () => {
    const value = grant();
    expect(activeOneBotAssignment(targetChatId)?.id).toBe(value.id);
    expect(activeOneBotAssignment(otherChatId)).toBeNull();
    expect(() => grant({ commandId: 'event-102' })).toThrow('active_assignment_exists');
    vi.setSystemTime(NOW + 600_001);
    const next = grant({ commandId: 'event-102', createdAt: NOW + 600_001, expiresAt: NOW + 700_000 });
    expect(activeOneBotAssignment(targetChatId)?.id).toBe(next.id);
    expect(getOneBotAssignment(value.id)?.state).toBe('expired');
  });

  it('authenticates owner stop and preserves revocation with disabled feature or removed allowlist', () => {
    const value = grant();
    const task = bind(value.id);
    expect(() => stopOneBotAssignment(value.id, controllerChatId + 1)).toThrow('controller_not_owner');
    mocks.config.QQ_ASSIGNMENTS_ENABLED = false;
    mocks.config.QQ_ASSIGNMENT_GROUP_IDS = '';
    expect(stopOneBotAssignment(value.id, controllerChatId).state).toBe('stopped');
    mocks.config.QQ_ASSIGNMENTS_ENABLED = true;
    mocks.config.QQ_ASSIGNMENT_GROUP_IDS = '50001';
    expect(() => assertOneBotAssignmentTask(task)).toThrow('stopped');
  });

  it('host group stop revokes only the exact group, including an in-flight reservation', () => {
    const value = grant();
    const other = grant({ commandId: 'event-102', targetChatId: otherChatId, targetGroupId: '50002' });
    const task = bind(value.id);
    const pending = reserveOneBotAssignmentSend(task.id, task.chatId, 2);
    expect(stopOneBotAssignmentsForChat(targetChatId)).toBe(1);
    expect(stopOneBotAssignmentsForChat(targetChatId)).toBe(0);
    expect(() => assertOneBotAssignmentReservation(pending.id)).toThrow('stopped');
    expect(getOneBotAssignment(other.id)?.state).toBe('active');
    expect(stopOneBotAssignmentsForChat(-123)).toBe(0);
  });

  it('binds tasks immutably and detects removed or invented grant tags while normal messages stay normal', () => {
    const value = grant();
    const task = bind(value.id);
    expect(() => bind(value.id)).not.toThrow();
    expect(assertOneBotAssignmentTask(task)?.id).toBe(value.id);
    expect(assertOneBotAssignmentTask({ id: 'normal', chatId: targetChatId })).toBeNull();
    expect(assertOneBotAssignmentTask({ id: 'telegram', chatId: -123 })).toBeNull();
    expect(() => assertOneBotAssignmentTask({ ...task, qqAssignmentId: undefined })).toThrow('task_binding_mismatch');
    expect(() => assertOneBotAssignmentTask({ ...task, chatId: -123, qqAssignmentId: undefined })).toThrow('task_binding_mismatch');
    expect(() => assertOneBotAssignmentTask({ ...task, id: 'invented' })).toThrow('task_binding_mismatch');
    expect(() => assertOneBotAssignmentTask({ ...task, chatId: otherChatId })).toThrow('task_binding_mismatch');
    const other = grant({ commandId: 'event-102', targetChatId: otherChatId, targetGroupId: '50002' });
    expect(() => bind(other.id, task.id, otherChatId)).toThrow('task_binding_mismatch');
  });

  it.each(['account', 'owner', 'allowlist', 'feature', 'deadline'] as const)('revalidates %s before each send bubble', (change) => {
    const value = grant();
    const task = bind(value.id);
    const pending = reserveOneBotAssignmentSend(task.id, task.chatId, 2);
    if (change === 'account') mocks.config.ONEBOT_ACCOUNT_ID = '80002';
    if (change === 'owner') mocks.config.ONEBOT_OWNER_ID = '70002';
    if (change === 'allowlist') mocks.config.QQ_ASSIGNMENT_GROUP_IDS = '50002';
    if (change === 'feature') mocks.config.QQ_ASSIGNMENTS_ENABLED = false;
    if (change === 'deadline') vi.setSystemTime(NOW + 600_000);
    expect(activeOneBotAssignment(targetChatId)).toBeNull();
    expect(() => assertOneBotAssignmentTask(task)).toThrow();
    expect(() => assertOneBotAssignmentReservation(pending.id)).toThrow();
  });

  it('atomically reserves full bubble plans and only one racing task obtains an unresolved intent', async () => {
    const value = grant();
    bind(value.id, 'race-a');
    bind(value.id, 'race-b');
    const results = await Promise.allSettled(['race-a', 'race-b'].map((taskId) =>
      Promise.resolve().then(() => reserveOneBotAssignmentSend(taskId, targetChatId, 3))));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(getOneBotAssignment(value.id)?.reservedMessages).toBe(3);
    expect(mocks.db!.prepare('SELECT COUNT(*) AS n FROM onebot_assignment_sends').get()).toEqual({ n: 1 });
  });

  it('holds the SQLite writer lock across the full reservation on independent connections', () => {
    const value = grant();
    bind(value.id, 'writer-a');
    bind(value.id, 'writer-b');
    const first = mocks.db!;
    const second = new Database(filename);
    second.pragma('foreign_keys = ON');
    second.pragma('busy_timeout = 0');
    let competingError: unknown;
    first.function('compete_for_reservation', () => {
      mocks.db = second;
      try { reserveOneBotAssignmentSend('writer-b', targetChatId, 3); }
      catch (error) { competingError = error; }
      finally { mocks.db = first; }
      return 0;
    });
    first.exec(`CREATE TRIGGER competing_writer BEFORE INSERT ON onebot_assignment_sends
      BEGIN SELECT compete_for_reservation(); END`);
    try {
      expect(reserveOneBotAssignmentSend('writer-a', targetChatId, 3).count).toBe(3);
      expect(competingError).toMatchObject({ code: 'SQLITE_BUSY' });
      mocks.db = second;
      expect(() => reserveOneBotAssignmentSend('writer-b', targetChatId, 3)).toThrow('pending_reservation');
      expect(getOneBotAssignment(value.id)?.reservedMessages).toBe(3);
    } finally { mocks.db = first; second.close(); }
  });

  it('deduplicates receipts, preserves reserved budget, and enforces interval for the next task', () => {
    const value = grant();
    bind(value.id, 'task-1');
    bind(value.id, 'task-2');
    const pending = reserveOneBotAssignmentSend('task-1', targetChatId, 2);
    acknowledgeOneBotAssignmentSend(pending.id, 0, '101');
    acknowledgeOneBotAssignmentSend(pending.id, 0, 101);
    expect(getOneBotAssignment(value.id)).toMatchObject({ reservedMessages: 2, acknowledgedMessages: 1 });
    expect(() => acknowledgeOneBotAssignmentSend(pending.id, 0, '102')).toThrow('receipt_mismatch');
    expect(() => acknowledgeOneBotAssignmentSend(pending.id, 1, '101')).toThrow('duplicate_receipt');
    expect(() => acknowledgeOneBotAssignmentSend(pending.id, 2, '102')).toThrow('invalid_receipt');
    expect(() => reserveOneBotAssignmentSend('task-2', targetChatId, 1)).toThrow('pending_reservation');
    acknowledgeOneBotAssignmentSend(pending.id, 1, '102');
    expect(() => reserveOneBotAssignmentSend('task-1', targetChatId, 1)).toThrow('send_already_reserved');
    expect(() => reserveOneBotAssignmentSend('task-2', targetChatId, 1)).toThrow('interval_not_elapsed');
    vi.setSystemTime(NOW + 30_000);
    expect(() => reserveOneBotAssignmentSend('task-2', targetChatId, 4)).toThrow('budget_exceeded');
    expect(reserveOneBotAssignmentSend('task-2', targetChatId, 3).count).toBe(3);
    expect(getOneBotAssignment(value.id)?.reservedMessages).toBe(5);
    expect(readOneBotAssignmentReceipts(value.id)).toHaveLength(3);
  });

  it('keeps reservations and task bindings after restart and never replays an unknown send', () => {
    const value = grant();
    const task = bind(value.id);
    const pending = reserveOneBotAssignmentSend(task.id, targetChatId, 1);
    mocks.db!.close();
    openDatabase();
    expect(assertOneBotAssignmentTask(task)?.id).toBe(value.id);
    expect(() => assertOneBotAssignmentTask(task, { executionStart: true })).toThrow('pending_reservation');
    expect(() => reserveOneBotAssignmentSend(task.id, targetChatId, 1)).toThrow('send_already_reserved');
    bind(value.id, 'task-2');
    expect(() => reserveOneBotAssignmentSend('task-2', targetChatId, 1)).toThrow('pending_reservation');
    failOneBotAssignmentSend(pending.id, true);
    expect(getOneBotAssignment(value.id)?.state).toBe('held');
    expect(() => assertOneBotAssignmentReservation(pending.id)).toThrow('reservation_not_pending');
    expect(() => reserveOneBotAssignmentSend('task-2', targetChatId, 1)).toThrow('held');
    acknowledgeOneBotAssignmentSend(pending.id, 0, 'real-late-receipt');
    expect(getOneBotAssignment(value.id)).toMatchObject({ state: 'held', acknowledgedMessages: 1 });
    expect(() => assertOneBotAssignmentTask(task, { executionStart: true })).toThrow('send_already_reserved');
  });

  it('a known failed send consumes its budget, cannot replay, and does not freeze other allowed tasks', () => {
    const value = grant();
    bind(value.id, 'task-1');
    bind(value.id, 'task-2');
    const pending = reserveOneBotAssignmentSend('task-1', targetChatId, 2);
    failOneBotAssignmentSend(pending.id, false);
    failOneBotAssignmentSend(pending.id, false);
    expect(getOneBotAssignment(value.id)).toMatchObject({ state: 'active', reservedMessages: 2, acknowledgedMessages: 0 });
    expect(() => reserveOneBotAssignmentSend('task-1', targetChatId, 2)).toThrow('send_already_reserved');
    vi.setSystemTime(NOW + 30_000);
    expect(reserveOneBotAssignmentSend('task-2', targetChatId, 3).count).toBe(3);
  });

  it('waits from the actual acknowledgement when a send takes longer than the interval', () => {
    const value = grant();
    bind(value.id, 'task-1');
    bind(value.id, 'task-2');
    const pending = reserveOneBotAssignmentSend('task-1', targetChatId, 1);
    vi.setSystemTime(NOW + 40_000);
    acknowledgeOneBotAssignmentSend(pending.id, 0, 'slow-receipt');
    expect(() => reserveOneBotAssignmentSend('task-2', targetChatId, 1)).toThrow('interval_not_elapsed');
    vi.setSystemTime(NOW + 70_000);
    expect(reserveOneBotAssignmentSend('task-2', targetChatId, 1).count).toBe(1);
  });

  it('never downgrades uncertainty if later evidence contradicts a claimed known failure', () => {
    const value = grant();
    const task = bind(value.id);
    const pending = reserveOneBotAssignmentSend(task.id, targetChatId, 1);
    failOneBotAssignmentSend(pending.id, false);
    failOneBotAssignmentSend(pending.id, true);
    failOneBotAssignmentSend(pending.id, false);
    expect(getOneBotAssignment(value.id)?.state).toBe('held');
    expect(readOneBotAssignmentReceipts(value.id)[0]?.state).toBe('unknown');
  });

  it('records real receipts if stop races with an already dispatched send', () => {
    const value = grant();
    const task = bind(value.id);
    const pending = reserveOneBotAssignmentSend(task.id, targetChatId, 1);
    stopOneBotAssignment(value.id, controllerChatId);
    acknowledgeOneBotAssignmentSend(pending.id, 0, 'platform-receipt');
    expect(getOneBotAssignment(value.id)).toMatchObject({ state: 'stopped', acknowledgedMessages: 1 });
    expect(readOneBotAssignmentReceipts(value.id)[0]).toMatchObject({ state: 'acknowledged', messageId: 'platform-receipt' });
  });

  it('rolls back a failed intent commit before it can authorize transport', () => {
    const value = grant();
    const task = bind(value.id);
    mocks.db!.exec(`CREATE TRIGGER fail_intent BEFORE INSERT ON onebot_assignment_sends
      BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END`);
    expect(() => reserveOneBotAssignmentSend(task.id, task.chatId, 2)).toThrow('disk unavailable');
    expect(getOneBotAssignment(value.id)?.reservedMessages).toBe(0);
    expect(readOneBotAssignmentReceipts(value.id)).toEqual([]);
    expect(mocks.db!.pragma('synchronous', { simple: true })).toBe(1);
  });

  it('a failed receipt commit leaves a durable unresolved intent that blocks replay', () => {
    const value = grant();
    const task = bind(value.id);
    const pending = reserveOneBotAssignmentSend(task.id, task.chatId, 1);
    mocks.db!.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON onebot_assignment_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END`);
    expect(() => acknowledgeOneBotAssignmentSend(pending.id, 0, '101')).toThrow('receipt unavailable');
    expect(getOneBotAssignment(value.id)).toMatchObject({ reservedMessages: 1, acknowledgedMessages: 0 });
    expect(readOneBotAssignmentReceipts(value.id)[0]?.state).toBe('reserved');
    mocks.db!.close();
    openDatabase();
    expect(() => reserveOneBotAssignmentSend(task.id, task.chatId, 1)).toThrow('send_already_reserved');
  });
});
