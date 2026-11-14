import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  config: { MASTER_UID: 12345, MASTER_UID_EXTRA: [] as number[], ONEBOT_ACCOUNT_ID: '80001', ONEBOT_OWNER_ID: '70001' },
}));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: mocks.getDb }));
vi.mock('../../../src/env.js', () => ({ env: () => mocks.config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getOrCreateConversationId, getOrCreateUserId, PLATFORM_INTERNAL_ID_BASE } from '../../../src/platform/identity-store.js';
import { isConversationOwner } from '../../../src/platform/owner-context.js';
import { getPlatformBotIdentity } from '../../../src/platform/account-context.js';
import { buildMasterIdentityBlock, masterShortHint } from '../../../src/shared/master-identity.js';
import { isMaster } from '../../../src/admin/auth.js';
import { evaluateRules, isMentioningSelf } from '../../../src/pipeline/judge/rules.js';
import { classifyAddressee } from '../../../src/pipeline/floor/addressee.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0118_platform_identity.sql', 'utf8'));
  mocks.getDb.mockReturnValue(db);
});
afterEach(() => db.close());
const group = { platform: 'qq' as const, accountId: '80001', idNamespace: 'qq-number' as const,
  conversationKind: 'group' as const, id: '60001' };

describe('QQ identity stays scoped through core and persona recognition', () => {
  it('allocates self in the current account and does not use the same QQ number in another account', () => {
    const chatId = getOrCreateConversationId(group);
    const otherChatId = getOrCreateConversationId({ ...group, accountId: '80002' });
    const identity = getPlatformBotIdentity(chatId, ['QQ喵'])!;
    expect(identity.uid).toBeGreaterThan(PLATFORM_INTERNAL_ID_BASE);
    expect(identity.username).toBe('');
    expect(getPlatformBotIdentity(otherChatId, ['QQ喵'])!.uid).not.toBe(identity.uid);
    expect(getPlatformBotIdentity(-100, ['TG喵'])).toBeNull();
    expect(() => getPlatformBotIdentity(-(PLATFORM_INTERNAL_ID_BASE + 999), [])).toThrow();
  });

  it('recognizes the QQ owner as persona only and never elevates it to Telegram admin', () => {
    const chatId = getOrCreateConversationId(group);
    const owner = getOrCreateUserId({ ...group, id: '70001' });
    const foreignOwner = getOrCreateUserId({ ...group, accountId: '80002', id: '70001' });
    expect(isConversationOwner(chatId, owner)).toBe(true);
    expect(isConversationOwner(chatId, foreignOwner)).toBe(false);
    expect(isConversationOwner(chatId, mocks.config.MASTER_UID)).toBe(false);
    expect(isMaster(owner, mocks.config.MASTER_UID)).toBe(false);
    expect(isMaster(mocks.config.MASTER_UID, mocks.config.MASTER_UID)).toBe(true);
    const block = buildMasterIdentityBlock(chatId);
    expect(block).toContain(`uid:${owner}`);
    expect(block).toContain('QQ:70001');
    expect(block).not.toContain('12345');
    expect(block).not.toContain('Zh_Taiwan');
    expect(masterShortHint(chatId)).not.toContain('12345');
    expect(buildMasterIdentityBlock(-100)).toContain('uid:12345');
    const otherChatId = getOrCreateConversationId({ ...group, accountId: '80002' });
    expect(buildMasterIdentityBlock(otherChatId)).toContain('未核验主人身份');
    expect(buildMasterIdentityBlock(otherChatId)).not.toContain('QQ:70001');
  });

  it('routes a QQ self mention through L0/floor while another mention stays another person', () => {
    const chatId = getOrCreateConversationId(group);
    const self = getPlatformBotIdentity(chatId, ['QQ喵'])!;
    const uid = getOrCreateUserId({ ...group, id: '70002' });
    const message: FormattedMessage = { role: 'user', uid, username: '', fullName: 'QQ user',
      messageId: 17, timestamp: 1, textContent: `@${self.uid}在吗`, isForwarded: false };
    const context = { message, recentMessages: [], chatId, botUid: self.uid, botUsername: self.username,
      botNicknames: self.nicknames, groupActivity: { messagesLast5Min: 0, messagesLast1Hour: 0 }, lastBotReplyIndex: -1 };
    expect(evaluateRules(context)).toMatchObject({ action: 'REPLY', rule: 'mention_self' });
    expect(classifyAddressee(message, [], self.uid, '', [], chatId).verdict).toBe('to_me');
    const other = { ...message, textContent: `@${uid}在吗` };
    expect(classifyAddressee(other, [], self.uid, '', [], chatId).verdict).toBe('to_other');
    expect(isMentioningSelf('@stranger', '', [], self.uid)).toBe(false);
    expect(isMentioningSelf(`@${self.uid}1`, '', [], self.uid)).toBe(false);
    expect(isMentioningSelf('@telegram_bot', 'telegram_bot', [])).toBe(true);
  });
});
