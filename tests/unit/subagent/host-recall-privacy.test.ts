import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  source: -200 as number | null,
  config: {
    BOT_TOKEN: '123:synthetic-test-token',
    CODEACT_BANNED_WORDS: [], PERSON_IDENTITY_ENABLED: true,
    MEMORY_CROSS_CONTEXT_ENABLED: false, MEMORY_VISIBILITY_ENABLED: true,
    MEMORY_SENSITIVE_CHAT_IDS: [-999], DIGEST_PERSIST_ENABLED: true,
  },
  searchMemoryByUser: vi.fn(async () => []),
  searchDigests: vi.fn(() => []),
  getRecent: vi.fn(async () => []),
}));
// This ordinary-task fixture has no owner assignment; durable grant behavior
// is exercised separately with the real assignment store and its migrations.
vi.mock('../../../src/platform/onebot-assignment-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/platform/onebot-assignment-store.js')>(),
  assertOneBotAssignmentTask: () => null,
}));
vi.mock('../../../src/env.js', () => ({ env: () => fixture.config }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: vi.fn(), sendSticker: vi.fn(), reactToMessage: vi.fn(), sendChatAction: vi.fn() }));
vi.mock('../../../src/memory/chroma.js', () => ({ searchMemory: vi.fn(async () => []), searchMemoryByUser: fixture.searchMemoryByUser, memorizeMessage: vi.fn() }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ addAssistant: vi.fn(), getRecent: fixture.getRecent }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotUid: () => 123 }));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({ getReadyStickersByIntent: () => [] }));
vi.mock('../../../src/tracking/person-identity.js', () => ({
  getPersonIdentity: () => ({ impression: 'PRIVATE_MARKER', primary_chat_id: fixture.source }),
  buildCrossGroupInjection: () => '',
}));
vi.mock('../../../src/meta/session-digest.js', () => ({ searchDigests: fixture.searchDigests }));

import { createHostApi } from '../../../src/subagent/host-api.js';

beforeEach(() => {
  fixture.source = -200;
  fixture.config.PERSON_IDENTITY_ENABLED = true;
  fixture.config.MEMORY_CROSS_CONTEXT_ENABLED = false;
  fixture.config.MEMORY_VISIBILITY_ENABLED = true;
  vi.clearAllMocks();
});

describe('host memory source boundaries', () => {
  it.each([[-200, -100], [42, -100], [42, 43], [-999, -100], [null, -100], [0, -100], [NaN, -100]])(
    'blocks foreign contextual, private or unknown identity source %s in chat %s', async (source, chatId) => {
      fixture.source = source;
      const host = createHostApi(chatId, { onEnd: () => {}, taskId: 'synthetic' });
      expect(await host.memory.recallPerson(7, 'who')).not.toContain('PRIVATE_MARKER');
      expect(fixture.searchMemoryByUser).not.toHaveBeenCalled();
    },
  );
  it.each([[-200, -200], [42, 42], [-999, -999]])('retains same-chat source %s in chat %s', async (source, chatId) => {
    fixture.source = source;
    const host = createHostApi(chatId, { onEnd: () => {}, taskId: 'synthetic' });
    expect(await host.memory.recallPerson(7, 'who')).toContain('PRIVATE_MARKER');
  });
  it.each([42, -200])('does not disclose source %s when the visibility feature is disabled', async (source) => {
    fixture.source = source;
    fixture.config.MEMORY_VISIBILITY_ENABLED = false;
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'synthetic' });
    expect(await host.memory.recallPerson(7, 'who')).not.toContain('PRIVATE_MARKER');
  });
  it('respects the identity feature switch', async () => {
    fixture.config.PERSON_IDENTITY_ENABLED = false;
    const host = createHostApi(-200, { onEnd: () => {}, taskId: 'synthetic' });
    expect(await host.memory.recallPerson(7, 'who')).not.toContain('PRIVATE_MARKER');
  });
  it('passes the bound chat to both vector recall and digest search', async () => {
    fixture.config.MEMORY_CROSS_CONTEXT_ENABLED = true;
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'synthetic' });
    await host.memory.recallPerson(7, 'topic');
    await host.memory.searchDigests('topic');
    expect(fixture.searchMemoryByUser).toHaveBeenCalledWith(7, 'topic', -100, 5, 2000);
    expect(fixture.searchDigests).toHaveBeenCalledWith('topic', 5, { sourceChatId: -100 });
  });
  it.each([42, -999, -200])('rejects foreign recentMessages source %s before reading context', async (source) => {
    fixture.config.MEMORY_VISIBILITY_ENABLED = false;
    const host = createHostApi(-100, { onEnd: () => {}, taskId: 'synthetic' });
    expect(await host.chats.recentMessages(source)).toBe('(private context unavailable)');
    expect(fixture.getRecent).not.toHaveBeenCalled();
  });
  it.each([42, -200, -999])('still reads the same conversation %s and forwards the trusted topic', async (chatId) => {
    const host = createHostApi(chatId, { onEnd: () => {}, taskId: 'synthetic', messageThreadId: 17 });
    await host.chats.recentMessages(chatId, 5);
    await host.memory.recentContext(6);
    expect(fixture.getRecent.mock.calls).toEqual([[chatId, 5, 17], [chatId, 6, 17]]);
  });
});
