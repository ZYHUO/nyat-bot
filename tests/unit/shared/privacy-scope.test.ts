import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

const db = new Database(':memory:');
db.exec(readFileSync('migrations/0118_platform_identity.sql', 'utf8'));
const config = { BOT_TOKEN: '123456:synthetic-only', MEMORY_SENSITIVE_CHAT_IDS: [-999],
  MEMORY_VISIBILITY_ENABLED: false, DM_AUTO_PRIVATE: false };
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
import { getOrCreateConversationId, getOrCreateUserId } from '../../../src/platform/identity-store.js';
import { canReadConversationSource, isValidConversationScope, resolveConversationScope, samePlatformAccount } from '../../../src/shared/privacy-scope.js';

const group = (accountId: string, id: string) => getOrCreateConversationId({ platform: 'qq', accountId, idNamespace: 'qq-number', conversationKind: 'group', id });
const dm = (accountId: string, id: string) => getOrCreateUserId({ platform: 'qq', accountId, idNamespace: 'qq-number', id });
beforeEach(() => { config.BOT_TOKEN = '123456:synthetic-only'; });

describe('proven conversation privacy scope', () => {
  it('uses real account mappings, never numeric coincidence across QQ/TG', () => {
    const a = group('41', '100'), b = group('42', '100'), u = dm('41', '7');
    expect(resolveConversationScope(a)).toMatchObject({ platform: 'qq', accountId: '41', conversationKind: 'group' });
    expect(samePlatformAccount(a, u)).toBe(true);
    expect(samePlatformAccount(a, b)).toBe(false);
    expect(samePlatformAccount(a, -100)).toBe(false);
    expect(resolveConversationScope(-100)).toMatchObject({ platform: 'telegram', accountId: '123456' });
  });

  it('fails closed for malformed IDs and unknown reserved conversations, even equal source/target', () => {
    for (const id of [0, NaN, Infinity, 1.2, 2 ** 52, 2 ** 52 + 10000, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isValidConversationScope(id)).toBe(false);
      expect(canReadConversationSource(id, id)).toBe(false);
    }
  });

  it('keeps proven same-conversation legacy/private records but rejects conflicting metadata', () => {
    expect(canReadConversationSource(7, 7, { visibility: 'private' })).toBe(true);
    expect(canReadConversationSource(-100, -100)).toBe(true);
    expect(canReadConversationSource(-100, -100, { sourcePlatform: 'qq' })).toBe(false);
    expect(canReadConversationSource(-100, -100, { sourceAccountId: 'other-account' })).toBe(false);
    config.BOT_TOKEN = '';
    expect(canReadConversationSource(-100, -100)).toBe(true);
    expect(samePlatformAccount(-100, -200)).toBe(false);
  });

  it('requires explicit public, platform and account proof before cross-conversation reads', () => {
    const publicSource = { visibility: 'public' as const, sourcePlatform: 'telegram' as const, sourceAccountId: '123456' };
    expect(canReadConversationSource(-100, -200, publicSource)).toBe(true);
    for (const source of [{}, { visibility: 'public' as const }, { ...publicSource, visibility: 'contextual' as const },
      { ...publicSource, sourceAccountId: '123455' }]) expect(canReadConversationSource(-100, -200, source)).toBe(false);
    expect(canReadConversationSource(7, -200, publicSource)).toBe(false);
    expect(canReadConversationSource(-999, -200, publicSource)).toBe(false);
  });

  it('allows explicitly public QQ data only within its account, never into Telegram or another QQ account', () => {
    const a = group('41', '101'), b = group('41', '102'), other = group('42', '102');
    const source = { visibility: 'public' as const, sourcePlatform: 'qq' as const, sourceAccountId: '41' };
    expect(canReadConversationSource(a, b, source)).toBe(true);
    expect(canReadConversationSource(a, other, source)).toBe(false);
    expect(canReadConversationSource(a, -102, source)).toBe(false);
    expect(canReadConversationSource(dm('41', '7'), b, source)).toBe(false);
  });
});
