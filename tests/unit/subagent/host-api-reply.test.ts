import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessage = vi.fn(async (_chatId: number, _text: string, replyTo?: number) => {
  void replyTo;
  return 42;
});

vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessage(...(args as [number, string, number?])),
  sendSticker: vi.fn(async () => 1),
  reactToMessage: vi.fn(async () => true),
  sendChatAction: vi.fn(async () => undefined),
}));

vi.mock('../../../src/env.js', () => ({
  env: () => ({ CODEACT_BANNED_WORDS: [], CODEACT_WEB_SEARCH_ENABLED: true }),
}));

vi.mock('../../../src/memory/chroma.js', () => ({
  searchMemory: vi.fn(async () => []),
  searchMemoryByUser: vi.fn(async () => []),
  memorizeMessage: vi.fn(async () => undefined),
}));

vi.mock('../../../src/pipeline/context/manager.js', () => ({
  addAssistant: vi.fn(async () => undefined),
  getRecent: vi.fn(async () => []),
}));

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    get: async () => null,
    set: async () => 'OK',
    del: async () => 1,
  }),
}));

vi.mock('../../../src/meta/answered.js', () => ({
  markMessageAnswered: vi.fn(async () => {}),
}));

vi.mock('../../../src/meta/timing-adapter.js', () => ({
  noteMetaBotReply: vi.fn(async () => {}),
}));

vi.mock('../../../src/pipeline/reply/anti-repeat.js', () => ({
  checkNearDuplicate: vi.fn(async () => ({ isNearDuplicate: false, ratio: 0 })),
}));

vi.mock('../../../src/knowledge/sticker/store.js', () => ({
  getReadyStickersByIntent: () => [],
}));

vi.mock('../../../src/tracking/person-identity.js', () => ({
  getPersonIdentity: () => null,
  buildCrossGroupInjection: () => '',
}));

describe('host sendText reply_to policy', () => {
  beforeEach(() => {
    sendMessage.mockClear();
  });

  it('DM: no default reply_to; explicit still works', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(7624515600, { onEnd: () => {}, defaultReplyTo: 99 });
    await host.telegram.sendText('嗨');
    expect(sendMessage.mock.calls[0]![2]).toBeUndefined();
    await host.telegram.sendText('强调这句', 99);
    expect(sendMessage.mock.calls[1]![2]).toBe(99);
  });

  it('group: default reply_to only on first bubble', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(-100123, { onEnd: () => {}, defaultReplyTo: 77 });
    await host.telegram.sendText('第一条');
    await host.telegram.sendText('第二条');
    expect(sendMessage.mock.calls[0]![2]).toBe(77);
    expect(sendMessage.mock.calls[1]![2]).toBeUndefined();
  });

  it('rejects echoing the latest user line', async () => {
    const { getRecent } = await import('../../../src/pipeline/context/manager.js');
    vi.mocked(getRecent).mockResolvedValueOnce([
      {
        role: 'user',
        uid: 1,
        username: 'u',
        fullName: 'u',
        textContent: '嫌贵别买',
        messageId: 10,
        timestamp: 1,
        isForwarded: false,
      },
    ] as never);
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(-100123, { onEnd: () => {}, defaultReplyTo: 10 });
    await expect(host.telegram.sendText('嫌贵别买')).rejects.toThrow('echo_user_text');
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
