import { z } from 'zod';
import type { Update } from 'grammy/types';
import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { isConversationOwner } from '../platform/owner-context.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import type { Platform } from '../platform/types.js';
import type { FormattedMessage } from '../shared/types.js';
import { formatMessage } from '../pipeline/formatter.js';

const chatIdSchema = z.number().int().safe().refine(value => value !== 0);
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const settingsSchema = z.object({ enabled: z.boolean(), publishToSource: z.boolean() }).strict();
const patchSchema = settingsSchema.partial().refine(value => Object.keys(value).length > 0);
const changeSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('patch'), sourceChatId: chatIdSchema, expectedRevision: revisionSchema, patch: patchSchema }).strict(),
  z.object({ operation: z.literal('rollback'), sourceChatId: chatIdSchema, expectedRevision: revisionSchema, revision: revisionSchema }).strict(),
]);
export type JournalSettings = z.infer<typeof settingsSchema>;
interface RevisionRow {
  source_platform: Platform;
  source_account_id: string;
  source_chat_id: number;
  revision: number;
  controller_platform: Platform;
  controller_account_id: string;
  controller_chat_id: number;
  actor_uid: number;
  message_id: number;
  created_at: number;
  operation: 'patch' | 'rollback';
  before_json: string;
  after_json: string;
  rollback_revision: number | null;
}
interface ConfigAccount { platform: Platform; accountId: string }
export interface JournalConfigView {
  sourceChatId: number;
  revision: number;
  settings: JournalSettings;
}

function allowed(chatId: number): boolean {
  return !!env().BUSINESS_CONFIG_ENABLED && (env().BUSINESS_CONFIG_CHAT_IDS ?? []).includes(chatId);
}

/** Only public account IDs are persisted; credentials never enter configuration history. */
function configAccount(chatId: number): ConfigAccount {
  const scope = resolveConversationScope(chatId);
  if (!scope?.accountId) throw new Error('business_config_account_unavailable');
  return { platform: scope.platform, accountId: scope.accountId };
}

function sameAccount(left: ConfigAccount, right: ConfigAccount): boolean {
  return left.platform === right.platform && left.accountId === right.accountId;
}

/** The model never supplies the controller identity. Empty rollout lists deny all. */
function assertController(controllerChatId: number): ConfigAccount {
  if (!allowed(controllerChatId) || controllerChatId <= 0 || !isConversationOwner(controllerChatId, controllerChatId)) {
    throw new Error('business_config_owner_dm_required');
  }
  return configAccount(controllerChatId);
}

function assertSource(controllerChatId: number, sourceChatId: number): ConfigAccount {
  chatIdSchema.parse(sourceChatId);
  if (!allowed(sourceChatId)) throw new Error('business_config_source_not_allowed');
  const source = configAccount(sourceChatId);
  if (!sameAccount(configAccount(controllerChatId), source)) throw new Error('business_config_account_mismatch');
  // Other people's DMs cannot become a journal source by configuration.
  if (sourceChatId > 0 && sourceChatId !== controllerChatId) throw new Error('business_config_private_source_denied');
  return source;
}

function baseline(sourceChatId: number): JournalSettings {
  const e = env();
  const raw = e.DREAM_JOURNAL_CHAT_ID;
  const destination = !raw || !Number.isFinite(raw) ? 0 : raw < 0 ? raw : Number(`-100${raw}`);
  return { enabled: e.DREAM_JOURNAL_ENABLED,
    publishToSource: destination === sourceChatId || (e.DREAM_JOURNAL_DM && sourceChatId === e.MASTER_UID) };
}

function latest(sourceChatId: number, source: ConfigAccount): RevisionRow | undefined {
  return getDb().prepare(`SELECT * FROM business_config_revisions
    WHERE source_platform = ? AND source_account_id = ? AND source_chat_id = ? ORDER BY revision DESC LIMIT 1`)
    .get(source.platform, source.accountId, sourceChatId) as RevisionRow | undefined;
}

/** Read on each invocation: no process-local cache can survive a configuration handoff. */
export function effectiveJournalConfig(sourceChatId: number): JournalConfigView {
  const fallback = { sourceChatId, revision: 0, settings: baseline(sourceChatId) };
  if (!allowed(sourceChatId)) return fallback;
  let source: ConfigAccount;
  try { source = configAccount(sourceChatId); }
  catch { return { ...fallback, settings: { enabled: false, publishToSource: false } }; }
  const row = latest(sourceChatId, source);
  if (!row) return fallback;
  // Existing revisions cannot carry authority across owner/account changes.
  try {
    const controller = assertController(row.controller_chat_id);
    if (!sameAccount(controller, { platform: row.controller_platform, accountId: row.controller_account_id })) {
      throw new Error('business_config_account_mismatch');
    }
    assertSource(row.controller_chat_id, sourceChatId);
  } catch {
    // Keep the CAS revision so the new authorized owner can explicitly repair it.
    // An obsolete owner's settings must not block every other scheduled source.
    return { sourceChatId, revision: row.revision, settings: { enabled: false, publishToSource: false } };
  }
  return { sourceChatId, revision: row.revision, settings: settingsSchema.parse(JSON.parse(row.after_json)) };
}

export function journalConfigView(controllerChatId: number, sourceChatId = controllerChatId): JournalConfigView & {
  history: Array<{ revision: number; createdAt: number; operation: string; settings: JournalSettings }>;
} {
  assertController(controllerChatId);
  const source = assertSource(controllerChatId, sourceChatId);
  const history = (getDb().prepare(`SELECT * FROM business_config_revisions
    WHERE source_platform = ? AND source_account_id = ? AND source_chat_id = ? ORDER BY revision DESC LIMIT 10`)
    .all(source.platform, source.accountId, sourceChatId) as RevisionRow[]).map(row => ({ revision: row.revision, createdAt: row.created_at,
      operation: row.operation, settings: settingsSchema.parse(JSON.parse(row.after_json)) }));
  return { ...effectiveJournalConfig(sourceChatId), history };
}

/** A model may prepare a change, but only an exact human command can commit it. */
export function previewJournalConfig(controllerChatId: number, input: unknown): {
  before: JournalConfigView; after: JournalSettings; command: string;
} {
  assertController(controllerChatId);
  const parsed = z.object({ sourceChatId: chatIdSchema, patch: patchSchema }).strict().parse(input);
  const before = journalConfigView(controllerChatId, parsed.sourceChatId);
  const after = settingsSchema.parse({ ...before.settings, ...parsed.patch });
  return { before, after, command: `/journal_config ${JSON.stringify({ operation: 'patch', sourceChatId: parsed.sourceChatId,
    expectedRevision: before.revision, patch: parsed.patch })}` };
}

/** Internal deterministic command boundary, deliberately absent from CodeAct RPC. */
export function handleJournalConfigCommand(chatId: number, message: FormattedMessage, arg: string): string {
  try {
    const controller = assertController(chatId);
    if (message.uid !== chatId || message.role !== 'user' || message.isBot || message.isAnonymous || message.isForwarded
      || !Number.isSafeInteger(message.messageId) || message.messageId <= 0) {
      throw new Error('business_config_human_command_required');
    }
    if (!arg.trim() || arg.trim() === 'show') return JSON.stringify(journalConfigView(chatId));
    const show = /^show (-?\d+)$/.exec(arg.trim());
    if (show) return JSON.stringify(journalConfigView(chatId, Number(show[1])));
    if (arg.length > 2000) throw new Error('business_config_command_too_long');
    const change = changeSchema.parse(JSON.parse(arg));
    const source = assertSource(chatId, change.sourceChatId);
    const db = getDb();
    const result = db.transaction(() => {
      const duplicate = db.prepare(`SELECT * FROM business_config_revisions
        WHERE controller_platform = ? AND controller_account_id = ? AND controller_chat_id = ? AND message_id = ?`)
        .get(controller.platform, controller.accountId, chatId, message.messageId) as RevisionRow | undefined;
      if (duplicate) return { sourceChatId: duplicate.source_chat_id, revision: duplicate.revision, duplicate: true };
      const before = effectiveJournalConfig(change.sourceChatId);
      if (before.revision !== change.expectedRevision) throw new Error('business_config_revision_conflict');
      let settings: JournalSettings;
      if (change.operation === 'patch') {
        settings = settingsSchema.parse({ ...before.settings, ...change.patch });
      } else {
        if (change.revision >= before.revision) throw new Error('business_config_rollback_must_be_older');
        const old = db.prepare(`SELECT * FROM business_config_revisions
          WHERE source_platform = ? AND source_account_id = ? AND source_chat_id = ? AND revision = ?`)
          .get(source.platform, source.accountId, change.sourceChatId, change.revision || 1) as RevisionRow | undefined;
        if (!old) throw new Error('business_config_revision_missing');
        settings = settingsSchema.parse(JSON.parse(change.revision === 0 ? old.before_json : old.after_json));
      }
      const revision = before.revision + 1;
      db.prepare(`INSERT INTO business_config_revisions
        (source_platform, source_account_id, source_chat_id, revision, controller_platform, controller_account_id,
          controller_chat_id, actor_uid, message_id, created_at, operation, before_json, after_json, rollback_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(source.platform, source.accountId, change.sourceChatId, revision, controller.platform, controller.accountId,
          chatId, message.uid, message.messageId, Date.now(), change.operation,
          JSON.stringify(before.settings), JSON.stringify(settings), change.operation === 'rollback' ? change.revision : null);
      return { sourceChatId: change.sourceChatId, revision, settings };
    }).immediate();
    return `日记配置已确认：${JSON.stringify(result)}。仅使用来源会话资料，发布也仅回到来源会话。`;
  } catch (error) {
    // Never echo submitted values, SQL, secrets or arbitrary validation payloads.
    const code = error instanceof Error && /^business_config_[a-z_]+$/.test(error.message)
      ? error.message : 'business_config_invalid_or_unavailable';
    return `日记配置未更改：${code}。先让本喵预览配置，再发送完整 /journal_config 命令确认。`;
  }
}

/** Shared Telegram/QQ ingress consumes exact human commands before any model routing. */
export async function tryHandleJournalConfigCommand(update: Update): Promise<boolean> {
  const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
  const match = /^\/journal_config(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(message?.text?.trim() ?? '');
  if (!match || !message) return false;
  const formatted = formatMessage(update);
  if (!formatted) return true;
  const raw = message as unknown as Record<string, unknown>;
  const forwarded = ['forward_origin', 'forward_date', 'forward_from', 'forward_from_chat', 'forward_sender_name',
    'via_bot', 'via_business_bot', 'sender_business_bot', 'business_connection_id', 'sender_chat']
    .some(field => raw[field] !== undefined);
  const age = Date.now() / 1000 - message.date;
  const addressed = !match[1] || match[1].toLowerCase() === (await import('../bot/bot.js')).getBotUsername(message.chat.id)?.replace(/^@/, '').toLowerCase();
  const valid = !!update.message && message.chat.type === 'private' && !message.edit_date && !forwarded
    && addressed && Number.isFinite(age) && age >= -30 && age <= 300;
  const reply = valid ? handleJournalConfigCommand(message.chat.id, formatted, match[2] ?? '')
    : '日记配置未更改：仅接受主人私聊中直接发送的新命令。';
  const { sendMessage } = await import('../bot/sender/telegram.js');
  await sendMessage(message.chat.id, reply);
  return true;
}

/** Cron takes a fresh snapshot; shared schedule/timezone remain operator-owned. */
export function scheduledJournalSources(): number[] {
  const sources = new Set<number>();
  if (env().DREAM_JOURNAL_ENABLED && env().MASTER_UID > 0) sources.add(env().MASTER_UID);
  if (env().BUSINESS_CONFIG_ENABLED) {
    const rows = getDb().prepare('SELECT DISTINCT source_platform, source_account_id, source_chat_id FROM business_config_revisions')
      .all() as Array<Pick<RevisionRow, 'source_platform' | 'source_account_id' | 'source_chat_id'>>;
    for (const row of rows) {
      if (!allowed(row.source_chat_id)) continue;
      try {
        if (!sameAccount(configAccount(row.source_chat_id), { platform: row.source_platform, accountId: row.source_account_id })) continue;
      } catch { continue; }
      const config = effectiveJournalConfig(row.source_chat_id);
      if (config.settings.enabled) sources.add(row.source_chat_id);
    }
  }
  return [...sources];
}
