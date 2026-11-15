import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Update } from 'grammy/types';
import { z } from 'zod';
import { env } from '../env.js';
import { isOneBotOwner } from '../platform/owner-context.js';
import { isPlatformInternalId } from '../platform/identity-store.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { logger } from '../shared/logger.js';

const releasePattern = /^[a-f0-9]{40}$/;
const requestIdPattern = /^[a-f0-9]{32}$/;
const resultSchema = z.object({
  version: z.literal(1), id: z.string().length(32).regex(requestIdPattern),
  status: z.enum(['succeeded', 'failed']),
  activeRelease: z.string().length(40).regex(releasePattern).nullable(),
  error: z.string().min(1).max(80).refine(value => !/[^a-z_]/.test(value)).nullable(),
}).strict();
type UpdateResult = z.infer<typeof resultSchema>;
type UpdateRequest = { version: 1; id: string; action: 'activate'; release: string }
  | { version: 1; id: string; action: 'rollback' };

function errno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Fixed, operator-created Linux directories. No model-controlled path is accepted. */
async function openDirectory(path: string, result: boolean): Promise<FileHandle> {
  if (!path || !isAbsolute(path) || await realpath(path) !== resolve(path)) throw new Error('update_directory_invalid');
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await directory.stat();
    const uid = result ? 0 : process.getuid?.();
    if (uid === undefined || stat.uid !== uid || (stat.mode & 0o022) !== 0) throw new Error('update_directory_permissions');
    return directory;
  } catch (error) { await directory.close(); throw error; }
}

// Anchor every leaf operation to the open descriptor so directory replacement
// cannot redirect IO. The external controller is Linux/systemd only as well.
function leaf(directory: FileHandle, name: string): string { return `/proc/self/fd/${directory.fd}/${name}`; }

async function readResult(directoryPath: string, id: string): Promise<UpdateResult | null> {
  if (id.length !== 32 || !requestIdPattern.test(id)) throw new Error('update_request_id_invalid');
  const directory = await openDirectory(directoryPath, true);
  try {
    let file: FileHandle;
    try { file = await open(leaf(directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (errno(error, 'ENOENT')) return null; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.size > 4096) throw new Error('update_result_invalid');
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 4096) throw new Error('update_result_invalid');
      const result = resultSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
      if (result.id !== id) throw new Error('update_result_id_mismatch');
      return result;
    } finally { await file.close(); }
  } finally { await directory.close(); }
}

async function publishRequest(directoryPath: string, request: UpdateRequest): Promise<'queued' | 'busy'> {
  const directory = await openDirectory(directoryPath, false);
  const temporary = leaf(directory, `.request-${randomBytes(16).toString('hex')}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await file.writeFile(JSON.stringify(request)); await file.sync(); }
    finally { await file.close(); }
    // link publishes a complete file atomically and refuses to overwrite an
    // unconsumed request, including a hostile symlink at the fixed destination.
    try { await link(temporary, leaf(directory, 'request.json')); }
    catch (error) { if (errno(error, 'EEXIST')) return 'busy'; throw error; }
    await directory.sync();
    return 'queued';
  } finally {
    if (created) await unlink(temporary).catch(() => {});
    await directory.close();
  }
}

function renderResult(result: UpdateResult): string {
  return `更新请求 ${result.id}：${result.status === 'succeeded' ? '已完成' : '失败'}；回执记录版本 ${result.activeRelease ?? '未知'}${result.error ? `；错误代码 ${result.error}` : ''}。`;
}

/** Exact authenticated human ingress only; deliberately absent from model RPC. */
export async function tryHandleUpdateCommand(update: Update): Promise<boolean> {
  const config = env();
  const candidate = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
  if (!config.UPDATE_REQUESTS_ENABLED || !candidate?.text || !/^\/update(?:\s|$)/.test(candidate.text)) return false;
  const message = update.message;
  if (!message || update.edited_message || message.chat.type !== 'private' || message.chat.id <= 0
    || !Number.isSafeInteger(message.chat.id) || !(config.UPDATE_CONTROL_CHAT_IDS ?? []).includes(message.chat.id)
    || !message.from || message.from.id !== message.chat.id || message.from.is_bot || message.sender_chat
    || message.forward_origin || message.via_bot || message.is_automatic_forward
    || !Number.isSafeInteger(message.message_id) || message.message_id <= 0) return true;
  // Reject legacy forwarding fields too; ingress adapters must not weaken this.
  const fields = message as unknown as Record<string, unknown>;
  if (['forward_from', 'forward_from_chat', 'forward_sender_name', 'forward_date',
    'via_business_bot', 'sender_business_bot', 'business_connection_id'].some(key => fields[key] !== undefined)) return true;
  const scope = resolveConversationScope(message.chat.id);
  if (!scope?.accountId || scope.conversationKind !== 'private') return true;
  try {
    if (scope.platform === 'qq') {
      if (!isOneBotOwner(message.chat.id, message.from.id) || config.ONEBOT_OWNER_ID === config.ONEBOT_ACCOUNT_ID) return true;
    } else if (isPlatformInternalId(message.from.id) || message.from.id !== config.MASTER_UID) return true;
  } catch { return true; }

  const { sendMessage } = await import('../bot/sender/telegram.js');
  const reply = async (text: string): Promise<void> => {
    try { await sendMessage(message.chat.id, text, message.message_id); }
    catch { logger.warn({ chatId: message.chat.id }, 'Update request reply could not be confirmed'); }
  };
  const age = Date.now() / 1000 - message.date;
  if (!Number.isFinite(age) || age < -30 || age > 300) {
    await reply('更新指令已过期，请重新发送明确指令。'); return true;
  }
  const rawText = message.text ?? '';
  const activate = /^\/update activate ([a-f0-9]{40})$/.exec(rawText);
  const status = /^\/update status ([a-f0-9]{32})$/.exec(rawText);
  const rollback = rawText === '/update rollback';
  if (rawText !== rawText.trim() || (!activate && !status && !rollback)) {
    await reply('支持 /update activate <40位小写提交SHA>、/update rollback、/update status <32位请求ID>。仅切换运维已批准的版本。');
    return true;
  }
  // Stable across durable ingress retries and Redis dedup outages. The controller
  // keeps durable receipts and refuses to execute a completed ID a second time.
  const id = status?.[1] ?? createHash('sha256').update(JSON.stringify([
    scope.platform, scope.accountId, message.chat.id, message.message_id, message.text,
  ])).digest('hex').slice(0, 32);
  try {
    const result = await readResult(config.UPDATE_RESULT_DIR, id);
    if (result) { await reply(renderResult(result)); return true; }
    if (status) { await reply(`更新请求 ${id} 尚无结果：可能排队、处理中或不存在。`); return true; }
    const request: UpdateRequest = activate
      ? { version: 1, id, action: 'activate', release: activate[1]! }
      : { version: 1, id, action: 'rollback' };
    const published = await publishRequest(config.UPDATE_REQUEST_DIR, request);
    logger.info({ requestId: id, action: request.action, chatId: message.chat.id, platform: scope.platform,
      outcome: published }, 'Update request audited');
    await reply(published === 'queued'
      ? `更新请求已排队，尚未完成。请求 ID：${id}。使用 /update status ${id} 查询结果。`
      : `已有更新请求等待处理，本次未覆盖它。请求 ID：${id}；可用 /update status ${id} 查询。`);
  } catch {
    // A failure after durable publication may still leave a queued request. Never
    // claim failure or retry with a new ID, and never expose exception/path data.
    logger.warn({ requestId: id, chatId: message.chat.id }, 'Update request state could not be confirmed');
    await reply(`无法确认更新请求状态。请求 ID：${id}；请使用 /update status ${id} 查询，或由运维检查控制器。`);
  }
  return true;
}
