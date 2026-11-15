import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '../../../src/platform/types.js';
import type { NormalizedOneBotRequest, OneBotRequestOptions } from '../../../src/platform/onebot-requests.js';

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: vi.fn(() => { throw new Error('test must inject its database'); }) }));
import { decodeOneBotRequest, OneBotRequestService } from '../../../src/platform/onebot-requests.js';

const NOW = 1_800_000_000_000;
const ACCOUNT = '80001';
const OWNER = '70001';
const migration = readFileSync('migrations/0119_onebot_requests.sql', 'utf8');
let db: Database.Database;
let service: OneBotRequestService;
let sequence: number;
const transport = {
  setFriendAddRequest: vi.fn<(input: { accountId: string; flag: string; approve: boolean }) => Promise<void>>(),
  setGroupAddRequest: vi.fn<(input: { accountId: string; flag: string; subType: 'add' | 'invite'; approve: boolean; reason?: string }) => Promise<void>>(),
  getGroupMemberInfo: vi.fn<(input: { accountId: string; groupId: string; userId: string }) => Promise<{ role: 'owner' | 'admin' | 'member' }>>(),
};
function makeService(overrides: Partial<OneBotRequestOptions> = {}): OneBotRequestService {
  return new OneBotRequestService({ accountId: ACCOUNT, ownerId: OWNER, enabled: true,
    activatedAtMs: NOW - 100_000, transport, ...overrides }, () => db);
}
function event(overrides: Partial<NormalizedOneBotRequest> = {}): NormalizedOneBotRequest {
  return { accountId: ACCOUNT, kind: 'friend', subType: 'friend', userId: '60001',
    flag: 'private-request-flag', comment: '我是新朋友', timestampMs: NOW, ...overrides };
}
function command(text: string, overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { ref: { conversation: { platform: 'qq', idNamespace: 'qq-number', accountId: ACCOUNT,
    conversationKind: 'private', id: OWNER }, id: String(++sequence) },
    sender: { platform: 'qq', idNamespace: 'qq-number', accountId: ACCOUNT, id: OWNER },
    timestampMs: NOW, segments: [{ type: 'text', text }], ...overrides };
}
function store(overrides: Partial<NormalizedOneBotRequest> = {}): string {
  const result = service.record(event(overrides));
  expect(result.status).toBe('stored');
  expect(result.id).toBeTruthy();
  return result.id!;
}
function row(id: string): { status: string; flag: string; result_code: string } {
  return db.prepare('SELECT status, flag, result_code FROM onebot_requests WHERE id = ?').get(id) as ReturnType<typeof row>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sequence = 0;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.exec(migration);
  transport.setFriendAddRequest.mockReset().mockResolvedValue(undefined);
  transport.setGroupAddRequest.mockReset().mockResolvedValue(undefined);
  transport.getGroupMemberInfo.mockReset().mockResolvedValue({ role: 'admin' });
  service = makeService();
});
afterEach(() => { vi.useRealTimers(); if (db.open) db.close(); });

describe('OneBot request boundary', () => {
  it('decodes official friend/group request fields without accepting other-account events', () => {
    const raw = { post_type: 'request', self_id: 80001, user_id: 60001, request_type: 'friend',
      flag: 'private-request-flag', comment: '我是新朋友', time: NOW / 1000 };
    expect(decodeOneBotRequest(raw, ACCOUNT)).toEqual(event());
    expect(decodeOneBotRequest({ ...raw, request_type: 'group', sub_type: 'invite', group_id: 50001 }, ACCOUNT))
      .toEqual(event({ kind: 'group', subType: 'invite', groupId: '50001' }));
    expect(decodeOneBotRequest({ post_type: 'message' }, ACCOUNT)).toBeNull();
    for (const invalid of [{ self_id: '80002' }, { user_id: Number.MAX_SAFE_INTEGER + 1 }, { flag: '' },
      { flag: 'bad\nflag' }, { time: 12.1 }, { comment: 'x'.repeat(2001) }, { request_type: 'group', sub_type: 'unknown' }]) {
      expect(() => decodeOneBotRequest({ ...raw, ...invalid }, ACCOUNT)).toThrow();
    }
  });

  it('persists pending requests without automatic action and deduplicates flags per account', () => {
    db.exec(migration);
    const id = store();
    expect(service.record(event())).toEqual({ status: 'duplicate', id });
    expect(service.record(event({ comment: 'changed content', userId: '60002' }))).toEqual({ status: 'duplicate', id });
    expect(db.prepare('SELECT COUNT(*) AS n FROM onebot_requests').get()).toEqual({ n: 1 });
    expect(row(id).status).toBe('pending');
    expect(transport.setFriendAddRequest).not.toHaveBeenCalled();
    expect(transport.setGroupAddRequest).not.toHaveBeenCalled();
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(() => service.record(event({ accountId: '80002' }))).toThrow('wrong_account');
  });

  it('ignores disabled, pre-activation, future, expired and aborted input', () => {
    expect(makeService({ enabled: false }).record(event()).status).toBe('ignored');
    expect(makeService({ activatedAtMs: 0 }).record(event()).status).toBe('ignored');
    for (const timestampMs of [NOW - 101_000, NOW + 301_000, NOW - 86_400_000]) {
      expect(service.record(event({ timestampMs })).status).toBe('ignored');
    }
    expect(service.record(event(), { signal: AbortSignal.abort() }).status).toBe('ignored');
    expect(db.prepare('SELECT COUNT(*) AS n FROM onebot_requests').get()).toEqual({ n: 0 });
  });

  it('limits unresolved queue size without evicting unknown intents', () => {
    const id = store();
    const insert = db.prepare(`INSERT INTO onebot_requests
      (id, account_id, kind, sub_type, user_id, flag_hash, flag, comment, event_at, received_at, expires_at, status, updated_at)
      VALUES (?, ?, 'friend', 'friend', '60001', ?, '', '', ?, ?, ?, 'unknown', ?)`);
    for (let i = 0; i < 499; i++) insert.run(`row-${i}`, ACCOUNT, `hash-${i}`, NOW, NOW, NOW + 1000, NOW);
    expect(service.record(event({ flag: 'new-flag' }))).toEqual({ status: 'full' });
    expect(service.record(event())).toEqual({ status: 'duplicate', id });
  });
});

describe('owner review commands and privacy', () => {
  it('lists opaque IDs and provides bilingual help without publishing raw flags', async () => {
    const id = store();
    const result = await service.handleCommand(command('QQ申请'));
    expect(result.reply).toContain(id);
    expect(result.reply).toContain('我是新朋友');
    expect(result.reply).not.toContain('private-request-flag');
    expect((await service.handleCommand(command('/qqhelp'))).reply).toContain('QQ通过');
    expect((await service.handleCommand(command('QQ帮助'))).reply).toContain('不自动批准');
    expect(await service.handleCommand(command('普通消息'))).toEqual({ handled: false });
  });

  it('consumes but does not disclose or execute commands from strangers, groups, Telegram or wrong accounts', async () => {
    const id = store();
    const base = command(`/qqapprove ${id}`);
    const bad = [
      { ...base, sender: { ...base.sender, id: '60002' } },
      { ...base, ref: { ...base.ref, conversation: { ...base.ref.conversation, conversationKind: 'group' as const, id: '50001' } } },
      { ...base, sender: { ...base.sender, platform: 'telegram' as const, idNamespace: 'telegram' as const } },
      { ...base, ref: { ...base.ref, conversation: { ...base.ref.conversation, accountId: '80002' } } },
      { ...base, timestampMs: NOW - 101_000 },
    ];
    for (const message of bad) expect(await service.handleCommand(message)).toEqual({ handled: true });
    expect(transport.setFriendAddRequest).not.toHaveBeenCalled();
    expect(row(id).status).toBe('pending');
  });

  it('does not look up another account request by opaque ID', async () => {
    const id = store();
    const other = makeService({ accountId: '80002' });
    const msg = command(`/qqapprove ${id}`);
    msg.ref.conversation.accountId = '80002';
    msg.sender.accountId = '80002';
    expect((await other.handleCommand(msg)).reply).toContain('没有找到此账号');
    expect(transport.setFriendAddRequest).not.toHaveBeenCalled();
  });

  it('bounds reasons and rejects non-text command segments before external calls', async () => {
    const id = store();
    expect((await service.handleCommand(command(`/qqreject ${id} ${'a'.repeat(201)}`))).reply).toContain('/qqhelp');
    const msg = command(`/qqapprove ${id}`);
    msg.segments = [...msg.segments, { type: 'unsupported', platformType: 'file' }];
    expect((await service.handleCommand(msg)).reply).toContain('纯文本');
    expect(transport.setFriendAddRequest).not.toHaveBeenCalled();
  });

  it('expires requests by original event time without reviving completed records', async () => {
    const id = store();
    vi.setSystemTime(NOW + 86_400_001);
    const msg = command(`/qqapprove ${id}`, { timestampMs: Date.now() });
    expect((await service.handleCommand(msg)).reply).toContain('已过期');
    expect(row(id)).toMatchObject({ status: 'expired', flag: '' });
    expect(service.record(event({ timestampMs: Date.now() - 1 }))).toEqual({ status: 'duplicate', id });
    expect(transport.setFriendAddRequest).not.toHaveBeenCalled();
  });
});

describe('confirmed action, capability and live group permission', () => {
  it.each([true, false])('requires a confirmed friend response for approve=%s and never replays it', async approve => {
    const id = store();
    const cmd = command(`${approve ? 'QQ通过' : 'QQ拒绝'} ${id}`);
    const result = await service.handleCommand(cmd);
    expect(result.reply).toContain(approve ? '已确认通过' : '已确认拒绝');
    expect(row(id)).toMatchObject({ status: approve ? 'approved' : 'rejected', flag: '', result_code: 'api_confirmed' });
    expect(transport.setFriendAddRequest).toHaveBeenCalledTimes(1);
    expect(transport.setFriendAddRequest).toHaveBeenCalledWith({ accountId: ACCOUNT, flag: 'private-request-flag', approve });
    await service.handleCommand(cmd);
    await makeService().handleCommand(command(`/qqapprove ${id}`));
    expect(transport.setFriendAddRequest).toHaveBeenCalledTimes(1);
  });

  it('supports group invitations without requiring bot membership in a group it has not joined', async () => {
    const id = store({ kind: 'group', subType: 'invite', groupId: '50001' });
    expect((await service.handleCommand(command(`/qqreject ${id} 暂不加入`))).reply).toContain('已确认拒绝');
    expect(transport.getGroupMemberInfo).not.toHaveBeenCalled();
    expect(transport.setGroupAddRequest).toHaveBeenCalledTimes(1);
    expect(transport.setGroupAddRequest).toHaveBeenCalledWith({ accountId: ACCOUNT,
      flag: 'private-request-flag', subType: 'invite', approve: false, reason: '暂不加入' });
  });

  it('checks the current bot group role for join review, never trusting the requesting user role', async () => {
    const id = store({ kind: 'group', subType: 'add', groupId: '50001' });
    transport.getGroupMemberInfo.mockResolvedValueOnce({ role: 'member' });
    expect((await service.handleCommand(command(`/qqapprove ${id}`))).reply).toContain('不是该群管理员');
    expect(row(id).status).toBe('pending');
    expect(transport.setGroupAddRequest).not.toHaveBeenCalled();
    expect((await service.handleCommand(command(`/qqapprove ${id}`))).reply).toContain('已确认通过');
    expect(transport.getGroupMemberInfo).toHaveBeenCalledWith({ accountId: ACCOUNT, groupId: '50001', userId: ACCOUNT });
    expect(transport.setGroupAddRequest).toHaveBeenCalledTimes(1);
  });

  it('fails closed for missing capabilities and unavailable role lookup', async () => {
    const friend = store();
    expect((await makeService({ transport: {} }).handleCommand(command(`/qqapprove ${friend}`))).reply).toContain('不支持');
    const group = store({ flag: 'group-flag', kind: 'group', subType: 'add', groupId: '50001' });
    transport.getGroupMemberInfo.mockRejectedValueOnce(new Error('private upstream body'));
    expect((await service.handleCommand(command(`/qqapprove ${group}`))).reply).toContain('无法取得');
    expect((await makeService({ transport: { setGroupAddRequest: transport.setGroupAddRequest } })
      .handleCommand(command(`/qqapprove ${group}`))).reply).toContain('无法核验');
    expect(transport.setFriendAddRequest).not.toHaveBeenCalled();
    expect(transport.setGroupAddRequest).not.toHaveBeenCalled();
  });
});

describe('durable intent and failure semantics', () => {
  it('persists the intent before the call and prevents concurrent decisions', async () => {
    const id = store();
    let release: () => void = () => {};
    transport.setFriendAddRequest.mockImplementation(() => {
      expect(row(id).status).toBe('processing');
      expect(db.prepare('SELECT COUNT(*) AS n FROM onebot_request_commands').get()).toEqual({ n: 1 });
      return new Promise(resolve => { release = resolve; });
    });
    const first = service.handleCommand(command(`/qqapprove ${id}`));
    expect((await makeService().handleCommand(command(`/qqreject ${id}`))).reply).toContain('处理未确认');
    release();
    expect((await first).reply).toContain('已确认通过');
    expect(transport.setFriendAddRequest).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown', 'untyped'])('keeps %s results locked across a reconstructed service and hides error contents', async delivery => {
    const id = store();
    const error = new Error('sensitive-upstream-flag-and-body');
    if (delivery !== 'untyped') Object.assign(error, { delivery });
    transport.setFriendAddRequest.mockRejectedValueOnce(error);
    const result = await service.handleCommand(command(`/qqapprove ${id}`));
    expect(result.reply).toContain('结果未知');
    expect(result.reply).not.toContain('sensitive');
    expect(row(id).status).toBe('unknown');
    await makeService().handleCommand(command(`/qqreject ${id}`));
    expect(transport.setFriendAddRequest).toHaveBeenCalledTimes(1);
  });

  it('permits a new explicit command only after definitely not_sent, never duplicate message replay', async () => {
    const id = store();
    transport.setFriendAddRequest.mockRejectedValueOnce(Object.assign(new Error('not ready'), { delivery: 'not_sent' }));
    const first = command(`/qqapprove ${id}`);
    expect((await service.handleCommand(first)).reply).toContain('确定未发出');
    expect(row(id)).toMatchObject({ status: 'pending', flag: 'private-request-flag' });
    expect((await makeService().handleCommand(first)).reply).toContain('没有重复执行');
    expect(transport.setFriendAddRequest).toHaveBeenCalledTimes(1);
    expect((await service.handleCommand(command(`/qqapprove ${id}`))).reply).toContain('已确认通过');
    expect(transport.setFriendAddRequest).toHaveBeenCalledTimes(2);
  });

  it('distinguishes platform API rejection from successfully rejecting the applicant', async () => {
    const id = store();
    transport.setFriendAddRequest.mockRejectedValueOnce(Object.assign(new Error('denied'), { delivery: 'rejected' }));
    const result = await service.handleCommand(command(`/qqreject ${id}`));
    expect(result.reply).toContain('平台拒绝了此次操作');
    expect(result.reply).not.toContain('已确认拒绝');
    expect(row(id).status).toBe('failed');
  });

  it('does not call the platform if persisting the initial intent fails', async () => {
    const id = store();
    db.exec(`CREATE TRIGGER fail_intent BEFORE UPDATE OF status ON onebot_requests
      WHEN NEW.status = 'processing' BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END`);
    expect((await service.handleCommand(command(`/qqapprove ${id}`))).reply).toContain('暂时无法确认');
    expect(transport.setFriendAddRequest).not.toHaveBeenCalled();
    expect(row(id).status).toBe('pending');
    expect(db.prepare('SELECT COUNT(*) AS n FROM onebot_request_commands').get()).toEqual({ n: 0 });
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
  });

  it('retains a processing hold when the result commit fails, so restart does not repeat an acknowledged action', async () => {
    const id = store();
    db.exec(`CREATE TRIGGER fail_result BEFORE UPDATE OF status ON onebot_requests
      WHEN NEW.status = 'approved' BEGIN SELECT RAISE(ABORT, 'result commit failed'); END`);
    expect((await service.handleCommand(command(`/qqapprove ${id}`))).reply).toContain('暂时无法确认');
    expect(row(id).status).toBe('processing');
    db.exec('DROP TRIGGER fail_result');
    expect((await makeService().handleCommand(command(`/qqapprove ${id}`))).reply).toContain('处理未确认');
    expect(transport.setFriendAddRequest).toHaveBeenCalledTimes(1);
  });

  it('rechecks expiry after asynchronous permission lookup before claiming an intent', async () => {
    const id = store({ kind: 'group', subType: 'add', groupId: '50001' });
    transport.getGroupMemberInfo.mockImplementation(async () => {
      vi.setSystemTime(NOW + 86_400_001);
      return { role: 'admin' };
    });
    expect((await service.handleCommand(command(`/qqapprove ${id}`))).reply).toContain('已过期');
    expect(transport.setGroupAddRequest).not.toHaveBeenCalled();
  });
});
