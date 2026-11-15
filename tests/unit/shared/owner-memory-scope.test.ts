import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let db: Database.Database;
const config = { BOT_TOKEN: '123:synthetic', MASTER_UID: 7, ONEBOT_ACCOUNT_ID: '41', ONEBOT_OWNER_ID: '8',
  OWNER_MEMORY_LINK_ENABLED: true as boolean | undefined, MEMORY_SENSITIVE_CHAT_IDS: [-999] };
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
import { getOrCreateUserId, getOrCreateConversationId } from '../../../src/platform/identity-store.js';
import { inspectOwnerMemorySource, resolveOwnerDmReadContext } from '../../../src/shared/owner-memory-scope.js';
import { canReadConversationSource } from '../../../src/shared/privacy-scope.js';

const qqUser = (id: string, accountId = '41') => getOrCreateUserId({ platform: 'qq', accountId, idNamespace: 'qq-number', id });
const qqGroup = (id: string, accountId = '41') => getOrCreateConversationId({ platform: 'qq', accountId, idNamespace: 'qq-number', id, conversationKind: 'group' });
let owner: number, bot: number, group: number;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0118_platform_identity.sql', 'utf8'));
  Object.assign(config, { BOT_TOKEN: '123:synthetic', MASTER_UID: 7, ONEBOT_ACCOUNT_ID: '41', ONEBOT_OWNER_ID: '8',
    OWNER_MEMORY_LINK_ENABLED: true, MEMORY_SENSITIVE_CHAT_IDS: [-999] });
  owner = qqUser('8'); bot = qqUser('41'); group = qqGroup('100');
});
afterEach(() => db.close());

describe('configured owner private audience', () => {
  it('links only the configured owner principals, with existing QQ aliases and platform accounts', () => {
    const context = resolveOwnerDmReadContext(7, 7)!;
    expect(context.accounts).toEqual([{ platform: 'telegram', accountId: '123' }, { platform: 'qq', accountId: '41' }]);
    expect(context.principals).toEqual([
      { platform: 'telegram', accountId: '123', uid: 7, dmChatId: 7, botUid: 123 },
      { platform: 'qq', accountId: '41', uid: owner, dmChatId: owner, botUid: bot },
    ]);
    expect(resolveOwnerDmReadContext(owner, owner)?.accounts).toEqual(context.accounts);
  });

  it('does not promote groups, another DM, raw QQ numbers or a model-supplied owner uid', () => {
    for (const chat of [-100, group, 8, qqUser('9'), 2 ** 52 + 99999, 0, NaN]) {
      expect(resolveOwnerDmReadContext(chat)).toBeNull();
      expect(resolveOwnerDmReadContext(chat, 7)).toBeNull();
    }
    expect(resolveOwnerDmReadContext(7, owner)).toBeNull();
    expect(resolveOwnerDmReadContext(owner, 7)).toBeNull();
  });

  it.each([false, undefined])('does not link separate platform administrators when explicit linking is %s', (enabled) => {
    config.OWNER_MEMORY_LINK_ENABLED = enabled;
    const tg = resolveOwnerDmReadContext(7)!;
    const qq = resolveOwnerDmReadContext(owner)!;
    expect(tg.accounts).toEqual([{ platform: 'telegram', accountId: '123' }]);
    expect(qq.accounts).toEqual([{ platform: 'qq', accountId: '41' }]);
    expect(inspectOwnerMemorySource({ sourceChatId: owner, uid: owner, role: 'user' }, tg)).toBeNull();
    expect(inspectOwnerMemorySource({ sourceChatId: -100, uid: 7, role: 'user' }, qq)).toBeNull();
  });

  it('requires a current account mapping and does not allocate missing configured identities', () => {
    const oldOwner = qqUser('8', '42');
    expect(resolveOwnerDmReadContext(oldOwner)).toBeNull();
    const before = db.prepare('SELECT COUNT(*) AS n FROM platform_identity_allocations').get();
    config.ONEBOT_OWNER_ID = '999';
    expect(resolveOwnerDmReadContext(owner)).toBeNull();
    expect(resolveOwnerDmReadContext(7)?.accounts).toEqual([{ platform: 'telegram', accountId: '123' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM platform_identity_allocations').get()).toEqual(before);
  });

  it('rejects a broken QQ private alias instead of falling back to Telegram', () => {
    db.prepare("DELETE FROM platform_identity_refs WHERE ref_kind = 'conversation' AND identity_id = ?").run(owner - 2 ** 52);
    expect(resolveOwnerDmReadContext(owner)).toBeNull();
    expect(resolveOwnerDmReadContext(7)?.accounts).toEqual([{ platform: 'telegram', accountId: '123' }]);
  });

  it('permits owner DM exchanges and own group words without relaxing ordinary disclosure', () => {
    const context = resolveOwnerDmReadContext(7)!;
    expect(inspectOwnerMemorySource({ sourceChatId: owner, uid: bot, role: 'assistant' }, context))
      .toMatchObject({ platform: 'qq', accountId: '41', provenance: 'verified_account' });
    expect(inspectOwnerMemorySource({ sourceChatId: group, uid: owner, role: 'user', visibility: 'contextual' }, context))
      .toMatchObject({ sourceChatId: group, visibility: 'contextual' });
    expect(inspectOwnerMemorySource({ sourceChatId: 7, uid: 123, role: 'assistant', sourceAccountId: '123' }, context))
      .toMatchObject({ platform: 'telegram', accountId: '123' });
    expect(canReadConversationSource(group, 7, { visibility: 'contextual' })).toBe(false);
  });

  it('labels legacy owner-authored Telegram words without fabricating an account or bot experience', () => {
    const context = resolveOwnerDmReadContext(owner)!;
    const source = { sourceChatId: -100, uid: 7, role: 'user' };
    expect(inspectOwnerMemorySource(source, context)).toMatchObject({ platform: 'telegram', accountId: null,
      provenance: 'legacy_owner_authored', visibility: 'unknown', label: '历史Telegram/账号未知（主人本人发言）' });
    expect(source).toEqual({ sourceChatId: -100, uid: 7, role: 'user' });
    expect(inspectOwnerMemorySource({ ...source, sourceAccountId: '124' }, context)).toBeNull();
    expect(inspectOwnerMemorySource({ sourceChatId: 7, uid: 123, role: 'assistant' }, context)).toBeNull();
  });

  it('rejects others DMs, others group words, group bot replies, sensitive and contradictory sources', () => {
    const context = resolveOwnerDmReadContext(owner)!;
    const cases = [
      { sourceChatId: 9, uid: 7, role: 'user' },
      { sourceChatId: qqUser('9'), uid: owner, role: 'user' },
      { sourceChatId: group, uid: qqUser('9'), role: 'user' },
      { sourceChatId: group, uid: bot, role: 'assistant' },
      { sourceChatId: -999, uid: 7, role: 'user' },
      { sourceChatId: group, uid: owner, role: 'user', sourceAccountId: '42' },
      { sourceChatId: group, uid: owner, role: 'user', sourcePlatform: 'telegram' },
      { sourceChatId: qqGroup('100', '42'), uid: owner, role: 'user' },
      { sourceChatId: -100, uid: 7, role: 'system' },
      { sourceChatId: -(2 ** 52 + 99999), uid: owner, role: 'user' },
    ];
    for (const item of cases) expect(inspectOwnerMemorySource(item, context)).toBeNull();
  });
});
