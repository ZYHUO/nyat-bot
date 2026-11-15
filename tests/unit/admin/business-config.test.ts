import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from 'grammy/types';
import type { FormattedMessage } from '../../../src/shared/types.js';

const f = vi.hoisted(() => ({ db: vi.fn(), send: vi.fn(), call: vi.fn(), recent: vi.fn(), getChat: vi.fn(),
  config: { BUSINESS_CONFIG_ENABLED: true, BUSINESS_CONFIG_CHAT_IDS: [42, -100, -200, 43],
    MASTER_UID: 42, BOT_TOKEN: '999:fixture', ONEBOT_ACCOUNT_ID: '900', ONEBOT_OWNER_ID: '800',
    DREAM_JOURNAL_ENABLED: false, DREAM_JOURNAL_CHAT_ID: 0, DREAM_JOURNAL_DM: false,
    DREAM_JOURNAL_DIR: '', DREAM_JOURNAL_USAGE: 'summarize' } }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: f.db }));
vi.mock('../../../src/env.js', () => ({ env: () => f.config }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: f.send }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: f.call }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: f.recent }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ lrange: async () => [], set: async () => 'OK' }) }));
vi.mock('../../../src/meta/global-state.js', () => ({ getGlobalState: () => ({ recentDigests: () => [] }) }));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: () => ({ api: { getChat: f.getChat } }), getBotUsername: () => 'fixture_bot' }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { effectiveJournalConfig, handleJournalConfigCommand, journalConfigView, previewJournalConfig,
  scheduledJournalSources, tryHandleJournalConfigCommand } from '../../../src/admin/business-config.js';
import { getOrCreateConversationId } from '../../../src/platform/identity-store.js';
import { buildMetaApiContext } from '../../../src/meta/meta-api.js';
import { META_CAPABILITY_METHODS, selectCodeActCapabilities } from '../../../src/sandbox/codeact/capabilities.js';
import { getJournalChannelInfo, readRecentDreamSnippet, runDreamJournal, tryWriteDreamJournal } from '../../../src/cron/dream-journal.js';

let db: Database.Database;
let dir: string;
function message(id = 1, uid = 42): FormattedMessage {
  return { role: 'user', uid, messageId: id, username: '', fullName: 'Owner', timestamp: Math.floor(Date.now() / 1000),
    textContent: '', isForwarded: false };
}
function patch(sourceChatId = -100, expectedRevision = 0, values = { enabled: true, publishToSource: true }) {
  return JSON.stringify({ operation: 'patch', sourceChatId, expectedRevision, patch: values });
}
function apply(arg: string, id = 1, uid = 42) { return handleJournalConfigCommand(uid, message(id, uid), arg); }
function rows() { return db.prepare('SELECT * FROM business_config_revisions ORDER BY revision').all(); }
beforeEach(async () => {
  vi.clearAllMocks();
  db = new Database(':memory:');
  for (const migration of ['0118_platform_identity.sql', '0133_business_config.sql']) db.exec(readFileSync(`migrations/${migration}`, 'utf8'));
  f.db.mockReturnValue(db);
  dir = await mkdtemp(join(tmpdir(), 'nyat-business-config-'));
  Object.assign(f.config, { BUSINESS_CONFIG_ENABLED: true, BUSINESS_CONFIG_CHAT_IDS: [42, -100, -200, 43],
    MASTER_UID: 42, BOT_TOKEN: '999:fixture', DREAM_JOURNAL_ENABLED: false, DREAM_JOURNAL_DIR: dir });
  f.call.mockResolvedValue({ content: 'WRITE\n\n本喵记下今天这个会话里发生的小事，也记住大家一起聊天的心情。', label: 'fixture' });
  f.recent.mockImplementation(async (sourceChatId: number) => [{ ...message(), textContent: `source ${sourceChatId} 的本地记录` }]);
  f.send.mockResolvedValue(1);
  f.getChat.mockResolvedValue({ username: 'fixture_journal' });
});
afterEach(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });

describe('owner reviewed journal configuration', () => {
  it('exposes a real isolated Meta preview and requires the exact owner command before mutation', async () => {
    const capabilities = selectCodeActCapabilities(buildMetaApiContext({ scopeChatId: 42 }), META_CAPABILITY_METHODS);
    const preview = await capabilities.get('journal.previewConfig')!({ sourceChatId: -100, patch: { enabled: true, publishToSource: true } }) as { command: string };
    expect(rows()).toHaveLength(0);
    expect(capabilities.has('journal.applyConfig')).toBe(false);
    const update = { update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Owner' }, text: preview.command } } as Update;
    expect(await tryHandleJournalConfigCommand(update)).toBe(true);
    expect(effectiveJournalConfig(-100)).toMatchObject({ revision: 1, settings: { enabled: true, publishToSource: true } });
    expect(rows()).toEqual([expect.objectContaining({ actor_uid: 42, controller_chat_id: 42, message_id: 1, operation: 'patch',
      source_platform: 'telegram', source_account_id: '999', controller_platform: 'telegram', controller_account_id: '999' })]);
    expect(f.send).toHaveBeenCalledWith(42, expect.stringContaining('已确认'));
  });

  it('rejects nonowners, groups, bots, forwarded commands and edited ingress messages', async () => {
    expect(apply(patch(), 1, 43)).toContain('owner_dm_required');
    expect(handleJournalConfigCommand(-100, message(), patch())).toContain('owner_dm_required');
    for (const extra of [{ isBot: true }, { isAnonymous: true }, { isForwarded: true }, { role: 'assistant' as const }, { uid: 43 }]) {
      expect(handleJournalConfigCommand(42, { ...message(), ...extra }, patch())).toContain('human_command_required');
    }
    await tryHandleJournalConfigCommand({ update_id: 1, edited_message: { message_id: 1, date: 1, edit_date: 2,
      chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false, first_name: 'Owner' }, text: `/journal_config ${patch()}` } });
    expect(rows()).toHaveLength(0);
  });

  it('rejects modern forwarding, inline bot, stale and suffixed edited envelopes before configuration changes', async () => {
    const base = { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Owner' }, text: `/journal_config ${patch()}` };
    for (const extra of [{ forward_origin: { type: 'hidden_user' } }, { via_bot: { id: 7 } }, { via_business_bot: { id: 7 } }, { date: 1 }, { sender_chat: { id: 42 } }]) {
      expect(await tryHandleJournalConfigCommand({ update_id: 1, message: { ...base, ...extra } } as Update)).toBe(true);
    }
    expect(await tryHandleJournalConfigCommand({ update_id: 1, edited_message: { ...base, text: `/journal_config@fixture_bot ${patch()}` } } as Update)).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  it('defaults off, requires explicit control and source graylists, and never permits secrets or arbitrary destinations', () => {
    f.config.BUSINESS_CONFIG_ENABLED = false;
    expect(apply(patch())).toContain('owner_dm_required');
    f.config.BUSINESS_CONFIG_ENABLED = true;
    f.config.BUSINESS_CONFIG_CHAT_IDS = [];
    expect(apply(patch())).toContain('owner_dm_required');
    f.config.BUSINESS_CONFIG_CHAT_IDS = [42, -100, 43];
    expect(apply(patch(-200))).toContain('source_not_allowed');
    expect(apply(patch(43))).toContain('private_source_denied');
    for (const value of [{ enabled: 'true' }, { targetChatId: -200 }, { api_key: 'secret-canary' }, { MASTER_UID: 43 }]) {
      const result = apply(JSON.stringify({ operation: 'patch', sourceChatId: -100, expectedRevision: 0, patch: value }));
      expect(result).toContain('invalid_or_unavailable');
      expect(result).not.toContain('secret-canary');
    }
    expect(rows()).toHaveLength(0);
  });

  it('uses CAS to reject stale edits, deduplicates message retries and appends rollback history', () => {
    expect(apply(patch())).toContain('已确认');
    expect(apply(patch())).toContain('duplicate');
    expect(apply(patch(), 2)).toContain('revision_conflict');
    expect(rows()).toHaveLength(1);
    expect(apply(JSON.stringify({ operation: 'rollback', sourceChatId: -100, expectedRevision: 1, revision: 0 }), 3)).toContain('已确认');
    expect(effectiveJournalConfig(-100)).toMatchObject({ revision: 2, settings: { enabled: false, publishToSource: false } });
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toMatchObject({ operation: 'rollback', rollback_revision: 0 });
  });

  it('rolls back atomically if the audit insert fails', () => {
    db.exec("CREATE TRIGGER reject_config BEFORE INSERT ON business_config_revisions BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    expect(apply(patch())).toContain('invalid_or_unavailable');
    expect(effectiveJournalConfig(-100).revision).toBe(0);
    expect(rows()).toHaveLength(0);
  });

  it('keeps owner and source platform/account boundaries distinct', () => {
    const qq = { platform: 'qq' as const, idNamespace: 'qq-number' as const, accountId: '900' };
    const owner = getOrCreateConversationId({ ...qq, conversationKind: 'private', id: '800' });
    const group = getOrCreateConversationId({ ...qq, conversationKind: 'group', id: '700' });
    const foreign = getOrCreateConversationId({ ...qq, accountId: '901', conversationKind: 'group', id: '700' });
    f.config.BUSINESS_CONFIG_CHAT_IDS.push(owner, group, foreign);
    expect(apply(patch(group), 1, owner)).toContain('已确认');
    expect(apply(patch(-100), 2, owner)).toContain('account_mismatch');
    expect(apply(patch(group), 2, 42)).toContain('account_mismatch');
    expect(apply(patch(foreign), 2, owner)).toContain('account_mismatch');
  });

  it('invalidates old owner authority per source and lets the new owner repair its revision', () => {
    apply(patch());
    f.config.MASTER_UID = 43;
    expect(scheduledJournalSources()).toEqual([]);
    expect(journalConfigView(43, -100)).toMatchObject({ revision: 1, settings: { enabled: false } });
    expect(apply(patch(-100, 1), 2, 43)).toContain('已确认');
    expect(scheduledJournalSources()).toEqual([-100]);
  });

  it('isolates approval, CAS, message replay, history and rollback when Telegram accounts share the same database', () => {
    expect(apply(patch())).toContain('已确认');
    f.config.BOT_TOKEN = '222:another-account';
    expect(effectiveJournalConfig(-100)).toMatchObject({ revision: 0, settings: { enabled: false, publishToSource: false } });
    expect(journalConfigView(42, -100).history).toEqual([]);
    expect(scheduledJournalSources()).toEqual([]);
    expect(apply(patch(-100, 1), 2)).toContain('revision_conflict');

    // Telegram message IDs can overlap across bots, even in the same owner's DM.
    const result = apply(patch(-100, 0, { enabled: true, publishToSource: false }), 1);
    expect(result).toContain('已确认');
    expect(result).not.toContain('duplicate');
    expect(apply(patch(-100, 1, { enabled: false, publishToSource: false }), 2)).toContain('已确认');
    expect(apply(JSON.stringify({ operation: 'rollback', sourceChatId: -100, expectedRevision: 2, revision: 1 }), 3)).toContain('已确认');
    expect(effectiveJournalConfig(-100)).toMatchObject({ revision: 3, settings: { enabled: true, publishToSource: false } });
    expect(journalConfigView(42, -100).history).toHaveLength(3);

    // Rotating only the secret for the original bot keeps that bot's own history.
    f.config.BOT_TOKEN = '999:rotated-credential';
    expect(effectiveJournalConfig(-100)).toMatchObject({ revision: 1, settings: { enabled: true, publishToSource: true } });
    expect(journalConfigView(42, -100).history).toHaveLength(1);
    expect(rows()).toHaveLength(4);
    expect(JSON.stringify(rows())).not.toContain('credential');
    expect(JSON.stringify(rows())).not.toContain('another-account');
  });

  it('fails closed when the current account cannot be resolved', () => {
    expect(apply(patch())).toContain('已确认');
    f.config.BOT_TOKEN = '';
    expect(effectiveJournalConfig(-100).settings).toEqual({ enabled: false, publishToSource: false });
    expect(scheduledJournalSources()).toEqual([]);
    expect(apply(patch(-100, 1), 2)).toContain('account_unavailable');
    expect(rows()).toHaveLength(1);
  });

  it('takes effect in the real writer and only publishes that source to itself', async () => {
    apply(patch());
    expect(scheduledJournalSources()).toEqual([-100]);
    expect(await runDreamJournal({ sourceChatId: -100 })).toBeTruthy();
    expect(f.recent).toHaveBeenCalledWith(-100, 60);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]![0]).toBe(-100);
    expect(await readRecentDreamSnippet(400, { sourceChatId: -200 })).toBeNull();
    expect(await runDreamJournal({ sourceChatId: -200 })).toBeNull();
    expect(await getJournalChannelInfo({ sourceChatId: -100 })).toEqual({ link: 'https://t.me/fixture_journal', chatId: -100 });
    expect(f.getChat).toHaveBeenCalledExactlyOnceWith(-100);
    expect(await getJournalChannelInfo({ sourceChatId: -200 })).toBeNull();
    expect(previewJournalConfig(42, { sourceChatId: -100, patch: { enabled: false } }).before.revision).toBe(1);
  });

  it('honors mid-flight disable before writing or sending, and prevents overlapping source writes', async () => {
    apply(patch());
    let finish!: (result: { content: string }) => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const writing = runDreamJournal({ sourceChatId: -100 });
    await vi.waitFor(() => expect(f.call).toHaveBeenCalled());
    expect(await tryWriteDreamJournal({ sourceChatId: -100, force: true })).toMatchObject({ reason: 'in_flight', wrote: false });
    expect(apply(patch(-100, 1, { enabled: false, publishToSource: false }), 2)).toContain('已确认');
    finish({ content: 'WRITE\n\n本喵刚准备落笔，但配置已被主人明确关闭，应当放弃本次输出。' });
    expect(await writing).toBeNull();
    expect(f.send).not.toHaveBeenCalled();
    expect(await readRecentDreamSnippet(400, { sourceChatId: -100 })).toBeNull();
  });
});
