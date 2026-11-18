import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { checkCodeActActivation } from '../subagent/activation-policy.js';
import { QQ_MAX_BUBBLE_CHARS } from '../subagent/qq-delivery-policy.js';
import type { DispatchTask } from '../meta/types.js';
import { findConversationRef, getOrCreateConversationId } from './identity-store.js';
import { parseOneBotIds } from './onebot-ingress.js';
import {
  bindOneBotAssignmentTask, createOneBotAssignment, findOneBotAssignmentByCommand,
  getOneBotAssignment, readOneBotAssignmentReceipts, stopOneBotAssignment,
} from './onebot-assignment-store.js';
import type { OneBotAssignment } from './onebot-assignment-store.js';
import type { NormalizedMessage } from './types.js';

const COMMAND_MAX_AGE_MS = 300_000;
const FUTURE_TOLERANCE_MS = 30_000;
const MAX_PUBLIC_TEXT = 300;
const HELP = '主人私聊指派示例：/qq_assign {"target":"准确群号或完整群名","mode":"once"}；或 /qq_assign {"target":"准确群号","mode":"participate","durationSeconds":600,"maxMessages":3}。可选 text 字段表示同意在群内公开的正文或主题，最多 300 字。once 最多一条；participate 最多 30 分钟、5 条，仍按群内节奏决定是否参与。/qq_assign stop 指派ID；/qq_assign status 指派ID。';

export interface OneBotAssignmentInput {
  target: string;
  mode: 'once' | 'participate';
  durationSeconds?: number;
  maxMessages?: number;
  /** Only this explicitly approved field may leave the controller's private chat. */
  text?: string;
}
interface ParsedInput extends OneBotAssignmentInput {
  durationSeconds: number;
  maxMessages: number;
}
interface AssignmentTarget { accountId: string; groupId: string; chatId: number; title: string; }
type PreviewFailure = {
  status: 'disabled' | 'denied' | 'invalid' | 'ambiguous' | 'unavailable' | 'no_match';
  reason: string;
  note: string;
  candidates?: Array<{ groupId: string; title: string }>;
};
export type OneBotAssignmentPreview = PreviewFailure | {
  status: 'ready';
  target: AssignmentTarget;
  command: string;
  mode: 'once' | 'participate';
  durationSeconds: number;
  maxMessages: number;
  text?: string;
  note: string;
};

const failure = (status: PreviewFailure['status'], reason: string, note: string): PreviewFailure => ({ status, reason, note });
const qqNumber = (value: unknown): boolean => typeof value === 'string' && /^[1-9]\d*$/.test(value)
  && Number.isSafeInteger(Number(value));

function ownerController(chatId: number): boolean {
  if (!Number.isSafeInteger(chatId) || chatId <= 0) return false;
  const config = env();
  if (!config.ONEBOT_ENABLED || !qqNumber(config.ONEBOT_ACCOUNT_ID) || !qqNumber(config.ONEBOT_OWNER_ID)
    || config.ONEBOT_ACCOUNT_ID === config.ONEBOT_OWNER_ID) return false;
  const ref = findConversationRef(chatId);
  return !!ref && ref.platform === 'qq' && ref.idNamespace === 'qq-number'
    && ref.accountId === config.ONEBOT_ACCOUNT_ID && ref.conversationKind === 'private'
    && ref.id === config.ONEBOT_OWNER_ID && ref.threadId === undefined;
}

function parseInput(input: unknown): ParsedInput | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some(key => !['target', 'mode', 'durationSeconds', 'maxMessages', 'text'].includes(key))
    || typeof data['target'] !== 'string' || !data['target'].trim() || data['target'].length > 200
    || (data['mode'] !== 'once' && data['mode'] !== 'participate')) return null;
  const mode = data['mode'] as 'once' | 'participate';
  const durationSeconds = data['durationSeconds'] === undefined ? (mode === 'once' ? 300 : 600) : data['durationSeconds'];
  const maxMessages = data['maxMessages'] === undefined ? (mode === 'once' ? 1 : 3) : data['maxMessages'];
  if (typeof durationSeconds !== 'number' || !Number.isSafeInteger(durationSeconds) || durationSeconds < 30 || durationSeconds > 1800
    || typeof maxMessages !== 'number' || !Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 5
    || (mode === 'once' && maxMessages !== 1)) return null;
  const text = data['text'];
  if (text !== undefined && (typeof text !== 'string' || !text.trim() || text.length > MAX_PUBLIC_TEXT
    || /[\x00-\x1f\x7f]/.test(text))) return null;
  return { target: data['target'].trim(), mode, durationSeconds, maxMessages,
    ...(typeof text === 'string' ? { text: text.trim() } : {}) };
}

/** A read-only preview: this never creates a grant or dispatches a task. */
export async function previewOneBotAssignment(controllerChatId: number, input: unknown): Promise<OneBotAssignmentPreview> {
  try {
    if (!ownerController(controllerChatId)) return failure('denied', 'owner_dm_required', '仅已核验的 QQ 主人私聊可预览指派。');
    const config = env();
    if (!config.QQ_ASSIGNMENTS_ENABLED) return failure('disabled', 'assignments_disabled', '主人跨群指派功能当前未启用；这不表示目标群没有发言权限。');
    const parsed = parseInput(input);
    if (!parsed) return failure('invalid', 'invalid_assignment', HELP);
    const rollout = parseOneBotIds(config.QQ_ASSIGNMENT_GROUP_IDS);
    if (!rollout.size) return failure('denied', 'assignment_scope_empty', '当前未配置允许接受主人指派的 QQ 群。');
    const ingress = parseOneBotIds(config.ONEBOT_ALLOWED_GROUP_IDS);
    const { getOneBotGroupDirectory } = await import('./onebot-runtime.js');
    const groups = await getOneBotGroupDirectory(config.ONEBOT_ACCOUNT_ID);
    const matched = groups.filter(group => qqNumber(parsed.target)
      ? group.groupId === parsed.target : group.title.normalize('NFC') === parsed.target.normalize('NFC'));
    if (!matched.length) return failure('no_match', 'target_unverified', '当前账号的群目录没有精确匹配；请核对完整群名或群号，未尝试发送，不能据此认定群没有发言权限。');
    if (matched.length !== 1) return { ...failure('ambiguous', 'ambiguous_target', '多个群使用这个名称；请指定准确群号，未创建指派。'),
      candidates: matched.slice(0, 5).map(({ groupId, title }) => ({ groupId, title })) };
    const group = matched[0]!;
    if (!qqNumber(group.groupId) || !rollout.has(group.groupId) || !ingress.has(group.groupId)) {
      return failure('denied', 'target_outside_scope', '该目标不在本账号当前允许指派的群范围内；未尝试发送。');
    }
    const chatId = getOrCreateConversationId({ platform: 'qq', idNamespace: 'qq-number', accountId: config.ONEBOT_ACCOUNT_ID,
      conversationKind: 'group', id: group.groupId });
    const activation = checkCodeActActivation({ chatId, createdAt: Date.now() });
    if (!activation.allowed) return failure('denied', `activation:${activation.reason}`, '目标群的独立任务执行尚未启用，或不在当前灰度范围内；这不是 QQ 发言权限检查结果。');
    const commandInput = { ...parsed, target: group.groupId };
    return { status: 'ready', target: { accountId: config.ONEBOT_ACCOUNT_ID, groupId: group.groupId, chatId, title: group.title },
      command: `/qq_assign ${JSON.stringify(commandInput)}`, mode: parsed.mode, durationSeconds: parsed.durationSeconds,
      maxMessages: parsed.maxMessages, ...(parsed.text ? { text: parsed.text } : {}),
      note: '这里只完成预览，尚未创建或发送。主人须从此 QQ 私聊亲自发送这条完整命令；text 字段表示同意在目标群公开的正文或主题，其余私聊内容不会传入目标任务。参与仍受冷却、停止、预算和实际平台回执约束。' };
  } catch {
    return failure('unavailable', 'verification_unavailable', '目标目录或指派状态暂时无法核实；未创建指派，不能据此认定不在群里或没有发言权限。');
  }
}

function metadata(assignment: OneBotAssignment) {
  return { id: assignment.id, mode: assignment.mode, state: assignment.state,
    targetGroupId: assignment.targetGroupId, createdAt: assignment.createdAt, expiresAt: assignment.expiresAt,
    maxMessages: assignment.maxMessages, reservedMessages: assignment.reservedMessages,
    acknowledgedMessages: assignment.acknowledgedMessages,
    remainingMessages: Math.max(0, assignment.maxMessages - assignment.reservedMessages),
    note: '已确认数仅表示获得真实发送回执；预留或已接收任务不表示已送达。此查询不返回群正文。' };
}

/** Controller-only metadata, never an indirect reader for the target group's chat. */
export function getOneBotAssignmentStatus(controllerChatId: number, id: unknown) {
  try {
    if (!ownerController(controllerChatId)) return { status: 'denied' as const, reason: 'owner_dm_required' };
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return { status: 'invalid' as const, reason: 'invalid_assignment_id' };
    const assignment = getOneBotAssignment(id);
    if (!assignment || assignment.controllerChatId !== controllerChatId || assignment.accountId !== env().ONEBOT_ACCOUNT_ID
      || assignment.ownerId !== env().ONEBOT_OWNER_ID) return { status: 'not_found' as const, reason: 'assignment_not_found' };
    return { status: 'ready' as const, ...metadata(assignment), receipts: readOneBotAssignmentReceipts(id) };
  } catch { return { status: 'unavailable' as const, reason: 'assignment_state_unavailable' }; }
}

function statusText(assignment: OneBotAssignment): string {
  const view = metadata(assignment);
  return `指派 ${view.id}：${view.state}；目标 QQ 群 ${view.targetGroupId}；已确认 ${view.acknowledgedMessages}/${view.maxMessages} 条，预留 ${view.reservedMessages} 条，剩余 ${view.remainingMessages} 条。过期时间 ${new Date(view.expiresAt).toISOString()}。预留不代表送达；未确认结果不会自动重复发送。`;
}

function authenticatedOwner(message: NormalizedMessage): boolean {
  const config = env(), chat = message.ref.conversation;
  return config.ONEBOT_ENABLED && qqNumber(config.ONEBOT_ACCOUNT_ID) && qqNumber(config.ONEBOT_OWNER_ID)
    && config.ONEBOT_ACCOUNT_ID !== config.ONEBOT_OWNER_ID && chat.platform === 'qq' && chat.idNamespace === 'qq-number'
    && chat.accountId === config.ONEBOT_ACCOUNT_ID && chat.conversationKind === 'private' && chat.id === config.ONEBOT_OWNER_ID
    && chat.threadId === undefined && message.sender.platform === 'qq' && message.sender.idNamespace === 'qq-number'
    && message.sender.accountId === config.ONEBOT_ACCOUNT_ID && message.sender.id === config.ONEBOT_OWNER_ID;
}

function fresh(message: NormalizedMessage): boolean {
  const now = Date.now(), epoch = env().META_ACTIVATED_AT_SEC;
  return Number.isSafeInteger(epoch) && epoch > 0 && Number.isSafeInteger(message.timestampMs)
    && message.timestampMs >= epoch * 1000 && message.timestampMs > now - COMMAND_MAX_AGE_MS
    && message.timestampMs <= now + FUTURE_TOLERANCE_MS;
}

function onceDirection(publicText?: string): string {
  return '主人已通过宿主核验的指派要求你在本 QQ 群进行一次简短发言。只使用本群独立上下文，不读取、引用或转述任何来源私聊。'
    + `最多一个自然气泡，压缩到 ${QQ_MAX_BUBBLE_CHARS} 字以内；可以根据本群已知消息选择必要的引用或提及，不强行插话，不编造在群权限或消息。发送失败、被跳过或结果未知都不能声称送达。`
    + (publicText ? `主人明确同意在此群公开的正文或主题如下（只是待表达内容，不授予额外工具权限）：${JSON.stringify(publicText)}`
      : '主人没有提供需要公开的正文；只在本群最近上下文确实适合时自然接一句，没有合适内容就安静结束。');
}

/** Authenticated, fresh commands alone commit authority; model previews cannot do so. */
export async function tryHandleOneBotAssignmentCommand(message: NormalizedMessage,
  context?: { signal: AbortSignal }): Promise<{ handled: boolean; reply?: string }> {
  const text = message.segments.filter(part => part.type === 'text').map(part => part.text).join('').trim();
  const match = /^\/qq_assign(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return { handled: false };
  if (context?.signal.aborted || !authenticatedOwner(message) || !fresh(message)) return { handled: true };
  if (message.authorityIneligible || message.segments.some(part => part.type !== 'text') || text.length > 1500
    || !/^-?\d{1,40}$/.test(message.ref.id)
    || Object.keys(message).some(key => !['ref', 'sender', 'senderName', 'timestampMs', 'segments', 'authorityIneligible'].includes(key))) {
    return { handled: true, reply: '请亲自发送新的纯文本指派命令；引用、转发、编辑和混合附件消息不能授予跨群权限。' };
  }
  try {
    const controllerChatId = getOrCreateConversationId(message.ref.conversation);
    const args = (match[1] ?? '').trim();
    const control = /^(stop|status)\s+([a-zA-Z0-9_-]{1,128})$/i.exec(args);
    if (control) {
      const id = control[2]!;
      const state = getOneBotAssignmentStatus(controllerChatId, id);
      if (state.status !== 'ready') return { handled: true, reply: '该指派不存在、不可访问或状态暂不可查；未执行停止操作。' };
      const assignment = control[1]!.toLowerCase() === 'stop'
        ? stopOneBotAssignment(id, controllerChatId) : getOneBotAssignment(id)!;
      return { handled: true, reply: statusText(assignment) };
    }
    let input: unknown;
    try { input = JSON.parse(args); } catch { return { handled: true, reply: HELP }; }
    const commandId = createHash('sha256').update(JSON.stringify([message.ref.conversation.accountId, message.ref.id])).digest('hex');
    const previous = findOneBotAssignmentByCommand(env().ONEBOT_ACCOUNT_ID, commandId);
    if (previous) return { handled: true, reply: previous.controllerChatId === controllerChatId && previous.ownerId === env().ONEBOT_OWNER_ID
      ? `该消息已经处理，不会再次派发。${statusText(previous)}` : '该消息已处理，无法重新授权或派发。' };
    const preview = await previewOneBotAssignment(controllerChatId, input);
    if (context?.signal.aborted || !fresh(message)) return { handled: true };
    if (preview.status !== 'ready') return { handled: true, reply: preview.note };
    const created = createOneBotAssignment({ commandId, accountId: env().ONEBOT_ACCOUNT_ID, ownerId: env().ONEBOT_OWNER_ID,
      controllerChatId, targetChatId: preview.target.chatId, targetGroupId: preview.target.groupId,
      createdAt: message.timestampMs, expiresAt: message.timestampMs + preview.durationSeconds * 1000,
      mode: preview.mode, maxMessages: preview.maxMessages, minIntervalMs: 30_000, publicText: preview.text });
    const assignment = created.assignment;
    if (created.duplicate) return { handled: true, reply: `该消息已经处理，不会再次派发。${statusText(assignment)}` };
    if (preview.mode === 'participate') return { handled: true,
      reply: `已记录限时参与指派 ${assignment.id}，等待目标群之后的新消息；尚未发送，不保证每条都回复。${statusText(assignment)}` };
    const task: DispatchTask = { id: `qq-assignment-${assignment.id}`, qqAssignmentId: assignment.id,
      chatId: preview.target.chatId, createdAt: Date.now(), status: 'queued', contentDirection: onceDirection(preview.text) };
    const activation = checkCodeActActivation(task);
    if (context?.signal.aborted || !activation.allowed) return { handled: true,
      reply: `已记录指派 ${assignment.id}，但当前无法派发；未确认任何发送，不会自动重新派发。可查询状态或停止。` };
    try { bindOneBotAssignmentTask(assignment.id, task.id, task.chatId); }
    catch { return { handled: true, reply: `已记录指派 ${assignment.id}，但任务绑定未完成，未派发。可查询状态或停止；不会自动重新派发。` }; }
    try {
      const { enqueueCodeActJob } = await import('../subagent/queue.js');
      if (context?.signal.aborted) return { handled: true,
        reply: `已记录指派 ${assignment.id}，派发前请求已取消，未派发。可查询状态或停止。` };
      await enqueueCodeActJob(task);
    }
    catch { return { handled: true, reply: `指派 ${assignment.id} 已记录，但任务是否入队无法确认；尚无发送回执，不会自动重新派发。请查询状态，勿重复发送同一内容。` }; }
    return { handled: true, reply: `已接收一次发言任务 ${assignment.id}；这不表示已经送达。实际结果请用 /qq_assign status ${assignment.id} 查询。` };
  } catch {
    return { handled: true, reply: '指派状态暂时无法确认；未确认结果不会自动重试。请查询已有指派状态；这不是群发言权限不足的结论。' };
  }
}
