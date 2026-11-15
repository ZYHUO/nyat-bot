import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/sqlite.js';
import type { NormalizedMessage } from './types.js';

export interface NormalizedOneBotRequest {
  accountId: string;
  kind: 'friend' | 'group';
  subType: 'friend' | 'add' | 'invite';
  userId: string;
  groupId?: string;
  /** A platform capability: persist privately, never expose in command replies or logs. */
  flag: string;
  comment: string;
  timestampMs: number;
}

export interface OneBotRequestTransport {
  setFriendAddRequest?: (input: { accountId: string; flag: string; approve: boolean; remark?: string }) => Promise<void>;
  setGroupAddRequest?: (input: { accountId: string; flag: string; subType: 'add' | 'invite'; approve: boolean; reason?: string }) => Promise<void>;
  getGroupMemberInfo?: (input: { accountId: string; groupId: string; userId: string }) => Promise<{ role: 'owner' | 'admin' | 'member' }>;
}

export interface OneBotRequestOptions {
  accountId: string;
  ownerId: string;
  enabled: boolean;
  activatedAtMs: number;
  transport: OneBotRequestTransport;
}

export interface OneBotRequestRecordResult {
  status: 'stored' | 'duplicate' | 'ignored' | 'full';
  id?: string;
}

export class OneBotRequestError extends Error {
  constructor(readonly code: string) {
    super(`OneBot request: ${code}`);
    this.name = 'OneBotRequestError';
  }
}

type RequestStatus = 'pending' | 'processing' | 'approved' | 'rejected' | 'expired' | 'unknown' | 'failed';
interface RequestRow {
  id: string;
  account_id: string;
  kind: 'friend' | 'group';
  sub_type: 'friend' | 'add' | 'invite';
  user_id: string;
  group_id: string | null;
  flag: string;
  comment: string;
  event_at: number;
  expires_at: number;
  status: RequestStatus;
  attempt_id: string | null;
}

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_PENDING = 500;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS_LABELS: Record<RequestStatus, string> = {
  pending: '待审核', processing: '处理未确认（请人工核对）', approved: '已通过', rejected: '已拒绝',
  expired: '已过期', unknown: '结果未知（禁止自动重试）', failed: '平台拒绝操作',
};

function qqId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? value : null;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Only called for events received after the transport has authenticated self_id. */
export function decodeOneBotRequest(raw: unknown, expectedAccountId: string): NormalizedOneBotRequest | null {
  const event = object(raw);
  if (!event || event['post_type'] !== 'request') return null;
  const accountId = qqId(event['self_id']);
  const userId = qqId(event['user_id']);
  if (!accountId || accountId !== expectedAccountId) throw new OneBotRequestError('wrong_account');
  if (!userId || userId === accountId) throw new OneBotRequestError('invalid_request_user');
  const kind = event['request_type'];
  const subType = kind === 'friend' ? 'friend' : event['sub_type'];
  if ((kind !== 'friend' && kind !== 'group') || (kind === 'group' && subType !== 'add' && subType !== 'invite')) {
    throw new OneBotRequestError('unsupported_request_type');
  }
  const groupId = kind === 'group' ? qqId(event['group_id']) : undefined;
  if (kind === 'group' && !groupId) throw new OneBotRequestError('invalid_group_id');
  const flag = event['flag'];
  const comment = event['comment'] ?? '';
  const time = event['time'];
  if (typeof flag !== 'string' || !flag.trim() || flag.length > 2048 || /[\x00-\x1f\x7f]/.test(flag)) {
    throw new OneBotRequestError('invalid_request_flag');
  }
  if (typeof comment !== 'string' || comment.length > 2000) throw new OneBotRequestError('invalid_request_comment');
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time <= 0 || !Number.isSafeInteger(time * 1000)) {
    throw new OneBotRequestError('invalid_request_time');
  }
  return { accountId, kind, subType: subType as NormalizedOneBotRequest['subType'], userId,
    ...(groupId ? { groupId } : {}), flag, comment, timestampMs: time * 1000 };
}

/** FULL commit is required before an external approval, even if the shared DB uses NORMAL. */
function durableWrite<T>(db: Database.Database, operation: () => T): T {
  if (db.inTransaction) throw new OneBotRequestError('nested_transaction_refused');
  const previous = db.pragma('synchronous', { simple: true });
  db.pragma('synchronous = FULL');
  try { return db.transaction(operation).immediate(); }
  finally { db.pragma(`synchronous = ${Number(previous)}`); }
}

function errorDelivery(error: unknown): 'not_sent' | 'rejected' | 'unknown' {
  const delivery = object(error)?.['delivery'];
  return delivery === 'not_sent' || delivery === 'rejected' ? delivery : 'unknown';
}
function preview(comment: string): string {
  return comment.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').slice(0, 120);
}

const HELP = `QQ 申请审核（仅主人私聊）
/qqrequests 或 QQ申请：查看待审及未确认申请
/qqrequests history 或 QQ申请 历史：查看最近处理记录
/qqapprove 申请ID 或 QQ通过 申请ID
/qqreject 申请ID [理由] 或 QQ拒绝 申请ID [理由]
/qqhelp 或 QQ帮助
不自动批准任何人；申请保留 24 小时审核窗口。结果未知或处理未确认时请在 QQ 客户端人工核对，不会自动重试。`;

export class OneBotRequestService {
  private readonly options: Readonly<OneBotRequestOptions>;

  constructor(options: OneBotRequestOptions, private readonly database: () => Database.Database = getDb) {
    if (qqId(options.accountId) !== options.accountId || qqId(options.ownerId) !== options.ownerId ||
      options.accountId === options.ownerId) throw new OneBotRequestError('invalid_identity_configuration');
    this.options = Object.freeze({ ...options });
  }

  private active(): boolean {
    return this.options.enabled && Number.isSafeInteger(this.options.activatedAtMs) && this.options.activatedAtMs > 0;
  }

  private fresh(timestampMs: number, now: number): boolean {
    return Number.isSafeInteger(timestampMs) && timestampMs >= this.options.activatedAtMs &&
      timestampMs > now - REQUEST_TTL_MS && timestampMs <= now + FUTURE_TOLERANCE_MS;
  }

  private expire(db: Database.Database, now: number): void {
    // Never expire an unresolved external intent back into a retryable state.
    db.prepare(`UPDATE onebot_requests SET status = 'expired', flag = '', updated_at = ?, result_code = 'expired'
      WHERE account_id = ? AND status = 'pending' AND expires_at <= ?`).run(now, this.options.accountId, now);
  }

  record(event: NormalizedOneBotRequest, context?: { signal: AbortSignal }): OneBotRequestRecordResult {
    if (!this.active() || context?.signal.aborted) return { status: 'ignored' };
    // Revalidate the public domain interface, not just the transport decoder.
    const validated = decodeOneBotRequest({ post_type: 'request', self_id: event.accountId, user_id: event.userId,
      request_type: event.kind, sub_type: event.subType, group_id: event.groupId,
      flag: event.flag, comment: event.comment, time: event.timestampMs / 1000 }, this.options.accountId)!;
    const now = Date.now();
    if (!this.fresh(validated.timestampMs, now)) return { status: 'ignored' };
    const db = this.database();
    const flagHash = createHash('sha256').update(validated.flag).digest('hex');
    return durableWrite<OneBotRequestRecordResult>(db, () => {
      this.expire(db, now);
      const existing = db.prepare(`SELECT id FROM onebot_requests WHERE account_id = ? AND kind = ? AND sub_type = ? AND flag_hash = ?`)
        .get(validated.accountId, validated.kind, validated.subType, flagHash) as { id: string } | undefined;
      if (existing) return { status: 'duplicate', id: existing.id };
      const count = db.prepare(`SELECT COUNT(*) AS n FROM onebot_requests WHERE account_id = ? AND status IN ('pending', 'processing', 'unknown')`)
        .get(validated.accountId) as { n: number };
      if (count.n >= MAX_PENDING) return { status: 'full' };
      const id = randomUUID();
      db.prepare(`INSERT INTO onebot_requests
        (id, account_id, kind, sub_type, user_id, group_id, flag_hash, flag, comment, event_at, received_at, expires_at, status, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(id, validated.accountId, validated.kind,
        validated.subType, validated.userId, validated.groupId ?? null, flagHash, validated.flag, validated.comment,
        validated.timestampMs, now, validated.timestampMs + REQUEST_TTL_MS, now);
      return { status: 'stored', id };
    });
  }

  private owner(message: NormalizedMessage): boolean {
    const chat = message.ref.conversation;
    return chat.platform === 'qq' && chat.idNamespace === 'qq-number' && chat.accountId === this.options.accountId &&
      chat.conversationKind === 'private' && chat.id === this.options.ownerId && chat.threadId === undefined &&
      message.sender.platform === 'qq' && message.sender.idNamespace === 'qq-number' &&
      message.sender.accountId === this.options.accountId && message.sender.id === this.options.ownerId;
  }

  async handleCommand(message: NormalizedMessage, context?: { signal: AbortSignal }): Promise<{ handled: boolean; reply?: string }> {
    const text = message.segments.filter(part => part.type === 'text').map(part => part.text).join('').trim();
    const match = /^(\/qqrequests|\/qqapprove|\/qqreject|\/qqhelp|QQ申请|QQ通过|QQ拒绝|QQ帮助)(?:\s+([\s\S]*))?$/i.exec(text);
    if (!match) return { handled: false };
    // Consume recognized commands from non-owners without leaking queue metadata to the model.
    if (!this.active() || !this.owner(message) || context?.signal.aborted || !this.fresh(message.timestampMs, Date.now())) {
      return { handled: true };
    }
    if (message.segments.some(part => part.type !== 'text') || text.length > 600 || !message.ref.id || message.ref.id.length > 128) {
      return { handled: true, reply: '请发送纯文本审核命令，拒绝理由最多 200 字。' };
    }
    const command = match[1]!.toLowerCase();
    const args = (match[2] ?? '').trim();
    if (command === '/qqhelp' || command === 'qq帮助') return { handled: true, reply: HELP };
    try {
      if (command === '/qqrequests' || command === 'qq申请') {
        if (args && args !== 'history' && args !== '历史') return { handled: true, reply: HELP };
        return { handled: true, reply: this.list(!!args) };
      }
      const [id, ...reasonParts] = args.split(/\s+/);
      const approve = command === '/qqapprove' || command === 'qq通过';
      const reason = reasonParts.join(' ');
      if (!id || !ID.test(id) || reason.length > 200 || (approve && reason)) return { handled: true, reply: HELP };
      return { handled: true, reply: await this.decide(id, approve, reason, message, context) };
    } catch {
      // Never echo errors containing request flags, comments or transport response bodies.
      return { handled: true, reply: '审核状态暂时无法确认；未确认的操作不会自动重试，请稍后查看申请列表并在 QQ 客户端核对。' };
    }
  }

  private list(history: boolean): string {
    const db = this.database();
    this.expire(db, Date.now());
    const rows = db.prepare(`SELECT id, kind, sub_type, user_id, group_id, comment, status FROM onebot_requests
      WHERE account_id = ? ${history ? '' : "AND status IN ('pending', 'processing', 'unknown', 'failed')"}
      ORDER BY received_at DESC, id DESC LIMIT 20`).all(this.options.accountId) as RequestRow[];
    if (rows.length === 0) return history ? '暂无申请记录。' : '暂无待审核或未确认的申请。';
    return ['QQ 申请（最近 20 条）', ...rows.map(row => [
      `${row.id}｜${STATUS_LABELS[row.status]}`,
      `${row.kind === 'friend' ? '好友申请' : row.sub_type === 'invite' ? '邀请机器人入群' : '申请加入群'}：QQ ${row.user_id}${row.group_id ? `，群 ${row.group_id}` : ''}`,
      ...(row.comment ? [`验证信息（对方提供）：${preview(row.comment)}`] : []),
    ].join('\n'))].join('\n\n');
  }

  private async decide(id: string, approve: boolean, reason: string, actor: NormalizedMessage, context?: { signal: AbortSignal }): Promise<string> {
    const db = this.database();
    this.expire(db, Date.now());
    const row = db.prepare('SELECT * FROM onebot_requests WHERE id = ? AND account_id = ?')
      .get(id, this.options.accountId) as RequestRow | undefined;
    if (!row) return '没有找到此账号的申请。';
    if (row.status !== 'pending') return `这条申请${STATUS_LABELS[row.status]}，没有重复执行。`;
    const transport = this.options.transport;
    if ((row.kind === 'friend' && !transport.setFriendAddRequest) || (row.kind === 'group' && !transport.setGroupAddRequest)) {
      return '当前 QQ 连接不支持处理此类申请，未执行操作。';
    }
    if (row.kind === 'group' && row.sub_type === 'add') {
      if (!transport.getGroupMemberInfo || !row.group_id) return '无法核验机器人群权限，未执行操作。';
      let member: { role: 'owner' | 'admin' | 'member' };
      try { member = await transport.getGroupMemberInfo({ accountId: this.options.accountId, groupId: row.group_id, userId: this.options.accountId }); }
      catch { return '无法取得机器人当前群权限，未执行操作。'; }
      if (member.role !== 'owner' && member.role !== 'admin') return '机器人目前不是该群管理员或群主，未执行操作。';
    }
    if (context?.signal.aborted || !this.fresh(actor.timestampMs, Date.now())) return '连接或命令已过期，未执行操作。';
    const attempt = randomUUID();
    const claimed = durableWrite(db, () => {
      this.expire(db, Date.now());
      const previous = db.prepare('SELECT request_id FROM onebot_request_commands WHERE account_id = ? AND message_id = ?')
        .get(this.options.accountId, actor.ref.id);
      if (previous) return false;
      const updated = db.prepare(`UPDATE onebot_requests SET status = 'processing', attempt_id = ?, decision = ?, decided_by = ?,
        updated_at = ?, result_code = 'intent_persisted' WHERE id = ? AND account_id = ? AND status = 'pending' AND expires_at > ?`)
        .run(attempt, Number(approve), this.options.ownerId, Date.now(), id, this.options.accountId, Date.now());
      if (updated.changes !== 1) return false;
      db.prepare('INSERT INTO onebot_request_commands (account_id, message_id, request_id, attempt_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(this.options.accountId, actor.ref.id, id, attempt, Date.now());
      return true;
    });
    if (!claimed) return '申请已处理、正在处理、已过期或该命令已执行，没有重复执行。';
    let outcome: RequestStatus;
    let code: string;
    try {
      if (context?.signal.aborted) throw Object.assign(new Error('aborted'), { delivery: 'not_sent' });
      if (row.kind === 'friend') await transport.setFriendAddRequest!({ accountId: row.account_id, flag: row.flag, approve });
      else await transport.setGroupAddRequest!({ accountId: row.account_id, flag: row.flag,
        subType: row.sub_type as 'add' | 'invite', approve, ...(!approve && reason ? { reason } : {}) });
      outcome = approve ? 'approved' : 'rejected';
      code = 'api_confirmed';
    } catch (error) {
      const delivery = errorDelivery(error);
      outcome = delivery === 'not_sent' ? 'pending' : delivery === 'rejected' ? 'failed' : 'unknown';
      code = `api_${delivery}`;
    }
    // A failed result commit leaves the durable processing intent in place, never retryable.
    const finished = durableWrite(db, () => db.prepare(`UPDATE onebot_requests SET status = ?, updated_at = ?, result_code = ?,
      flag = CASE WHEN ? = 'pending' THEN flag ELSE '' END WHERE id = ? AND account_id = ? AND status = 'processing' AND attempt_id = ?`)
      .run(outcome, Date.now(), code, outcome, id, row.account_id, attempt));
    if (finished.changes !== 1) throw new OneBotRequestError('result_commit_conflict');
    if (outcome === 'pending') return '操作确定未发出；申请仍待审核。需要重试时请重新发送一条审核命令。';
    if (outcome === 'unknown') return '操作结果未知；已锁定这条申请，禁止自动重试。请在 QQ 客户端人工核对。';
    if (outcome === 'failed') return 'QQ 平台拒绝了此次操作，没有宣称通过或拒绝成功。请在 QQ 客户端核对。';
    return approve ? 'QQ 平台已确认通过这条申请。' : 'QQ 平台已确认拒绝这条申请。';
  }
}
