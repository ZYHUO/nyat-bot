import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchTask } from '../../../src/meta/types.js';
import type { NormalizedMessage } from '../../../src/platform/types.js';

const fixtures = vi.hoisted(() => ({
  env: {
    ONEBOT_ENABLED: true, ONEBOT_ACCOUNT_ID: '80001', ONEBOT_OWNER_ID: '70001',
    ONEBOT_ALLOWED_GROUP_IDS: '50001,50002', QQ_ASSIGNMENTS_ENABLED: true, QQ_ASSIGNMENT_GROUP_IDS: '50001,50002',
    META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true, META_SUBAGENT_CHAT_IDS: [] as number[],
    META_ACTIVATED_AT_SEC: 1_799_999_000,
  },
  directory: vi.fn(), enqueue: vi.fn<(task: DispatchTask) => Promise<void>>(), getDb: vi.fn(),
}));
vi.mock('../../../src/env.js', () => ({ env: () => fixtures.env }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: fixtures.getDb }));
vi.mock('../../../src/platform/onebot-runtime.js', () => ({ getOneBotGroupDirectory: fixtures.directory }));
vi.mock('../../../src/subagent/queue.js', () => ({ enqueueCodeActJob: fixtures.enqueue }));
// The service needs only the allowlist parser, never real ingress or Redis.
vi.mock('../../../src/platform/onebot-ingress.js', () => ({ parseOneBotIds: (raw: string) => {
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (ids.some(id => !/^[1-9]\d*$/.test(id))) throw new Error('invalid_allowlist');
  return new Set(ids);
} }));

import { getOrCreateConversationId } from '../../../src/platform/identity-store.js';
import {
  acknowledgeOneBotAssignmentSend, failOneBotAssignmentSend, getOneBotAssignment, reserveOneBotAssignmentSend,
} from '../../../src/platform/onebot-assignment-store.js';
import {
  getOneBotAssignmentStatus, previewOneBotAssignment, tryHandleOneBotAssignmentCommand,
} from '../../../src/platform/onebot-assignments.js';

const NOW = 1_800_000_000_000;
let db: Database.Database;
let sequence: number;
let ownerChatId: number;
const ownerRef = { platform: 'qq' as const, idNamespace: 'qq-number' as const, accountId: '80001',
  conversationKind: 'private' as const, id: '70001' };
const once = { target: '50001', mode: 'once', text: '大家好，今天在聊什么？' };
function command(args: string | object = once, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { ref: { conversation: ownerRef, id: String(++sequence) }, sender: {
    platform: 'qq', idNamespace: 'qq-number', accountId: '80001', id: '70001',
  }, timestampMs: NOW, segments: [{ type: 'text', text: `/qq_assign ${typeof args === 'string' ? args : JSON.stringify(args)}` }], ...overrides };
}
function count(): number { return (db.prepare('SELECT COUNT(*) AS n FROM onebot_assignments').get() as { n: number }).n; }
function task(): DispatchTask { return fixtures.enqueue.mock.calls[0]![0]; }
function firstId(): string { return (db.prepare('SELECT id FROM onebot_assignments LIMIT 1').get() as { id: string }).id; }

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); sequence = 0;
  Object.assign(fixtures.env, { ONEBOT_ENABLED: true, ONEBOT_ACCOUNT_ID: '80001', ONEBOT_OWNER_ID: '70001',
    ONEBOT_ALLOWED_GROUP_IDS: '50001,50002', QQ_ASSIGNMENTS_ENABLED: true, QQ_ASSIGNMENT_GROUP_IDS: '50001,50002',
    META_SUBAGENT_ENABLED: true, CODEACT_ISOLATION_ENABLED: true, META_SUBAGENT_CHAT_IDS: [], META_ACTIVATED_AT_SEC: 1_799_999_000 });
  db = new Database(':memory:'); db.pragma('foreign_keys = ON');
  db.exec(readFileSync('migrations/0118_platform_identity.sql', 'utf8'));
  db.exec(readFileSync('migrations/0134_onebot_assignments.sql', 'utf8'));
  fixtures.getDb.mockReset().mockReturnValue(db);
  fixtures.directory.mockReset().mockResolvedValue([{ groupId: '50001', title: '朋友群' }, { groupId: '50002', title: '工作群' }]);
  fixtures.enqueue.mockReset().mockResolvedValue(undefined);
  ownerChatId = getOrCreateConversationId(ownerRef);
});
afterEach(() => { vi.useRealTimers(); db.close(); });

describe('owner assignment preview and verified destination', () => {
  it('resolves one exact group and returns a canonical confirm command without creating anything', async () => {
    const result = await previewOneBotAssignment(ownerChatId, { ...once, target: '朋友群' });
    expect(result).toMatchObject({ status: 'ready', mode: 'once', maxMessages: 1,
      target: { accountId: '80001', groupId: '50001', title: '朋友群' } });
    if (result.status !== 'ready') throw new Error('expected ready');
    expect(JSON.parse(result.command.slice('/qq_assign '.length))).toMatchObject({ target: '50001', mode: 'once', maxMessages: 1 });
    expect(result.note).toContain('尚未创建或发送');
    expect(count()).toBe(0); expect(fixtures.enqueue).not.toHaveBeenCalled();
    expect(fixtures.directory).toHaveBeenCalledWith('80001');
  });

  it('refuses ambiguous names and never treats unknown directory state as no permission', async () => {
    fixtures.directory.mockResolvedValue([{ groupId: '50001', title: '朋友群' }, { groupId: '50002', title: '朋友群' }]);
    expect(await previewOneBotAssignment(ownerChatId, { ...once, target: '朋友群' })).toMatchObject({ status: 'ambiguous' });
    expect(await previewOneBotAssignment(ownerChatId, { ...once, target: '朋友' })).toMatchObject({ status: 'no_match' });
    fixtures.directory.mockRejectedValue(new Error('secret transport body'));
    const unavailable = await previewOneBotAssignment(ownerChatId, once);
    expect(unavailable).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(unavailable)).not.toContain('secret transport');
    expect(count()).toBe(0);
  });

  it.each(['QQ_ASSIGNMENT_GROUP_IDS', 'ONEBOT_ALLOWED_GROUP_IDS'] as const)('requires explicit inclusion in %s', async key => {
    fixtures.env[key] = '';
    expect(await previewOneBotAssignment(ownerChatId, once)).toMatchObject({ status: 'denied' });
    expect(count()).toBe(0);
  });

  it.each([
    { mode: 'once', maxMessages: 2 }, { mode: 'participate', maxMessages: 6 },
    { mode: 'participate', durationSeconds: 1801 }, { durationSeconds: 0 }, { maxMessages: 1.2 },
    { durationSeconds: null }, { maxMessages: null },
    { text: 'x'.repeat(301) }, { text: 'private\nsecret' }, { target: 50001 }, { mode: ['once'] }, { arbitraryPrivilege: true },
  ])('rejects invalid or broadened input %j', async override => {
    expect(await previewOneBotAssignment(ownerChatId, { ...once, ...override })).toMatchObject({ status: 'invalid' });
    expect(count()).toBe(0);
  });

  it('checks activation and rollout without granting Meta scope changes', async () => {
    fixtures.env.META_SUBAGENT_CHAT_IDS = [-100123];
    expect(await previewOneBotAssignment(ownerChatId, once)).toMatchObject({ status: 'denied', reason: 'activation:chat_outside_scope' });
    fixtures.env.META_SUBAGENT_CHAT_IDS = []; fixtures.env.CODEACT_ISOLATION_ENABLED = false;
    expect(await previewOneBotAssignment(ownerChatId, once)).toMatchObject({ status: 'denied', reason: 'activation:isolation_disabled' });
    fixtures.env.QQ_ASSIGNMENTS_ENABLED = false;
    expect((await tryHandleOneBotAssignmentCommand(command())).reply).toContain('当前未启用');
    expect(count()).toBe(0);
  });
});

describe('authenticated command boundary', () => {
  it('leaves ordinary private and group chatter on its normal route', async () => {
    const ordinary = command(); ordinary.segments = [{ type: 'text', text: '去朋友群聊两句吧' }];
    expect(await tryHandleOneBotAssignmentCommand(ordinary)).toEqual({ handled: false });
    ordinary.ref.conversation = { ...ownerRef, conversationKind: 'group', id: '50001' };
    expect(await tryHandleOneBotAssignmentCommand(ordinary)).toEqual({ handled: false });
    expect(fixtures.directory).not.toHaveBeenCalled(); expect(fixtures.enqueue).not.toHaveBeenCalled();
  });

  it('rejects stranger, forged identity, wrong account, group and platform commands', async () => {
    const base = command();
    const invalid: NormalizedMessage[] = [
      { ...base, sender: { ...base.sender, id: '60001' } },
      { ...base, sender: { ...base.sender, accountId: '80002' } },
      { ...base, sender: { ...base.sender, platform: 'telegram', idNamespace: 'telegram' } },
      { ...base, ref: { ...base.ref, conversation: { ...ownerRef, conversationKind: 'group', id: '50001' } } },
      { ...base, ref: { ...base.ref, conversation: { ...ownerRef, id: '60001' } } },
      { ...base, ref: { ...base.ref, conversation: { ...ownerRef, accountId: '80002' } } },
      { ...base, ref: { ...base.ref, conversation: { ...ownerRef, threadId: '1' } } },
    ];
    for (const message of invalid) expect(await tryHandleOneBotAssignmentCommand(message)).toEqual({ handled: true });
    expect(fixtures.directory).not.toHaveBeenCalled(); expect(count()).toBe(0);
  });

  it('rejects mixed, quoted, forwarded and edited commands before directory or queue access', async () => {
    const base = command();
    for (const type of ['forward', 'node']) {
      const message: NormalizedMessage = { ...base, segments: [...base.segments, { type: 'unsupported', platformType: type }] };
      expect((await tryHandleOneBotAssignmentCommand(message)).reply).toContain('纯文本');
    }
    expect((await tryHandleOneBotAssignmentCommand({ ...base, segments: [...base.segments, { type: 'reply', message: base.ref }] })).reply).toContain('纯文本');
    for (const authorityIneligible of ['edited', 'forwarded'] as const) {
      expect((await tryHandleOneBotAssignmentCommand({ ...base, authorityIneligible })).reply).toContain('纯文本');
    }
    expect(fixtures.directory).not.toHaveBeenCalled(); expect(count()).toBe(0);
  });

  it('rejects stale, pre-activation, future and aborted events', async () => {
    for (const timestampMs of [NOW - 300_000, NOW + 30_001, 1_799_998_999_000]) {
      expect(await tryHandleOneBotAssignmentCommand(command(once, { timestampMs }))).toEqual({ handled: true });
    }
    expect(await tryHandleOneBotAssignmentCommand(command(), { signal: AbortSignal.abort() })).toEqual({ handled: true });
    expect(fixtures.directory).not.toHaveBeenCalled(); expect(count()).toBe(0);
  });

  it('rechecks cancellation after asynchronous target verification', async () => {
    const controller = new AbortController();
    fixtures.directory.mockImplementation(async () => { controller.abort(); return [{ groupId: '50001', title: '朋友群' }]; });
    expect(await tryHandleOneBotAssignmentCommand(command(), { signal: controller.signal })).toEqual({ handled: true });
    expect(count()).toBe(0); expect(fixtures.enqueue).not.toHaveBeenCalled();
  });
});

describe('bounded dispatch, stop, status and durable replay', () => {
  it('creates an independent target task, awaits admission, and never reports delivery from enqueue', async () => {
    const result = await tryHandleOneBotAssignmentCommand(command());
    expect(result.reply).toContain('不表示已经送达');
    expect(fixtures.enqueue).toHaveBeenCalledOnce(); expect(count()).toBe(1);
    expect(task()).toEqual({ id: `qq-assignment-${firstId()}`, qqAssignmentId: firstId(),
      chatId: expect.any(Number), createdAt: NOW, status: 'queued', contentDirection: expect.stringContaining(once.text) });
    expect(task().chatId).toBeLessThan(0); expect(task().chatId).not.toBe(ownerChatId);
    expect(getOneBotAssignment(firstId())).toMatchObject({ mode: 'once', maxMessages: 1, acknowledgedMessages: 0 });
    expect(getOneBotAssignmentStatus(ownerChatId, firstId())).toMatchObject({ status: 'ready', acknowledgedMessages: 0, receipts: [] });
  });

  it('deduplicates the original event durably and never requeues after admission uncertainty', async () => {
    fixtures.enqueue.mockRejectedValueOnce(new Error('queue accepted but acknowledgement lost'));
    const original = command();
    expect((await tryHandleOneBotAssignmentCommand(original)).reply).toContain('入队无法确认');
    fixtures.directory.mockRejectedValue(new Error('directory now unavailable'));
    expect((await tryHandleOneBotAssignmentCommand(original)).reply).toContain('不会再次派发');
    expect(count()).toBe(1); expect(fixtures.enqueue).toHaveBeenCalledOnce();
    expect(fixtures.directory).toHaveBeenCalledOnce();
  });

  it('does not acknowledge task admission while the queue acknowledgement is still pending', async () => {
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    fixtures.enqueue.mockImplementationOnce(async () => { started(); await held; });
    let finished = false;
    const pending = tryHandleOneBotAssignmentCommand(command()).then(result => { finished = true; return result; });
    await entered;
    expect(finished).toBe(false);
    expect(getOneBotAssignmentStatus(ownerChatId, firstId())).toMatchObject({ acknowledgedMessages: 0 });
    release();
    expect((await pending).reply).toContain('不表示已经送达');
  });

  it('concurrent duplicate commands bind and enqueue a single task', async () => {
    // Hold the first verified directory response so both commands pass the early
    // lookup before either durable create; the store must settle this race.
    let release!: () => void, started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    fixtures.directory.mockImplementationOnce(async () => {
      started(); await held; return [{ groupId: '50001', title: '朋友群' }];
    });
    const original = command();
    const first = tryHandleOneBotAssignmentCommand(original);
    await entered;
    const second = await tryHandleOneBotAssignmentCommand(original);
    release();
    const results = [await first, second];
    expect(results.map(result => result.reply)).toEqual(expect.arrayContaining([expect.stringContaining('不会再次派发')]));
    expect(count()).toBe(1); expect(fixtures.enqueue).toHaveBeenCalledOnce();
  });

  it('allows an owner to request a single natural contribution without supplying private text', async () => {
    const result = await tryHandleOneBotAssignmentCommand(command({ target: '50001', mode: 'once' }));
    expect(result.reply).toContain('不表示已经送达');
    expect(task().contentDirection).toContain('没有合适内容就安静结束');
    expect(getOneBotAssignment(firstId())?.publicText).toBeUndefined();
    expect(getOneBotAssignmentStatus(ownerChatId, firstId())).toMatchObject({ acknowledgedMessages: 0, maxMessages: 1 });
  });

  it('participation waits for future group messages and can be stopped after feature disable', async () => {
    const original = command({ target: '50001', mode: 'participate', durationSeconds: 60, maxMessages: 2, text: '聊聊最近看的电影' });
    const result = await tryHandleOneBotAssignmentCommand(original);
    expect(result.reply).toContain('等待目标群之后的新消息');
    expect(fixtures.enqueue).not.toHaveBeenCalled();
    const id = firstId(); fixtures.env.QQ_ASSIGNMENTS_ENABLED = false;
    expect((await tryHandleOneBotAssignmentCommand(command(`stop ${id}`))).reply).toContain('stopped');
    expect((await tryHandleOneBotAssignmentCommand(original)).reply).toContain('不会再次派发');
    expect(getOneBotAssignmentStatus(ownerChatId, id)).toMatchObject({ status: 'ready', state: 'stopped' });
  });

  it('expires from the original event time and a replay never renews its budget or deadline', async () => {
    const original = command({ target: '50001', mode: 'participate', durationSeconds: 30, maxMessages: 1 });
    await tryHandleOneBotAssignmentCommand(original);
    const id = firstId(); vi.setSystemTime(NOW + 31_000);
    expect(getOneBotAssignmentStatus(ownerChatId, id)).toMatchObject({ state: 'expired', expiresAt: NOW + 30_000 });
    expect((await tryHandleOneBotAssignmentCommand(original)).reply).toContain('不会再次派发');
    expect(getOneBotAssignment(id)?.expiresAt).toBe(NOW + 30_000);
  });

  it('returns only receipt metadata to the owner, and never returns approved text or target history', async () => {
    await tryHandleOneBotAssignmentCommand(command());
    const reserved = reserveOneBotAssignmentSend(task().id, task().chatId, 1);
    acknowledgeOneBotAssignmentSend(reserved.id, 0, 'receipt-123');
    const status = getOneBotAssignmentStatus(ownerChatId, firstId());
    expect(status).toMatchObject({ status: 'ready', acknowledgedMessages: 1, remainingMessages: 0,
      receipts: [expect.objectContaining({ state: 'acknowledged', messageId: 'receipt-123' })] });
    expect(JSON.stringify(status)).not.toContain(once.text);
    const stranger = getOrCreateConversationId({ ...ownerRef, id: '60001' });
    expect(getOneBotAssignmentStatus(stranger, firstId())).toEqual({ status: 'denied', reason: 'owner_dm_required' });
  });

  it('reports unknown delivery as held without counting a confirmation or permitting replay', async () => {
    const original = command(); await tryHandleOneBotAssignmentCommand(original);
    const reserved = reserveOneBotAssignmentSend(task().id, task().chatId, 1);
    failOneBotAssignmentSend(reserved.id, true);
    expect(getOneBotAssignmentStatus(ownerChatId, firstId())).toMatchObject({ state: 'held', acknowledgedMessages: 0,
      receipts: [expect.objectContaining({ state: 'unknown' })] });
    expect((await tryHandleOneBotAssignmentCommand(original)).reply).toContain('不会再次派发');
    expect(fixtures.enqueue).toHaveBeenCalledOnce();
  });
});
