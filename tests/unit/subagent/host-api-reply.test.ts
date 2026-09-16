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

  it('rejects text that already contains [object Object] coercion junk', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(7624515600, { onEnd: () => {} });
    await expect(
      host.telegram.sendText('1. Q版猫猫:\n[object Object]\n喜欢吗？'),
    ).rejects.toThrow(/sendText_object_coercion/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects non-string sendText payloads', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(7624515600, { onEnd: () => {} });
    await expect(
      host.telegram.sendText({ messageId: 1 } as unknown as string),
    ).rejects.toThrow(/sendText_non_string/);
  });

  it('unescapes literal \\n from double-escaped model output (2026-08-24 做梦字条事故)', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(7624515600, { onEnd: () => {} });
    await host.telegram.sendText('第一件事：喂猫\\n\\n第二件事：睡觉');
    const sent = String(sendMessage.mock.calls[0]![1]);
    expect(sent).toContain('第一件事：喂猫\n\n第二件事：睡觉');
    expect(sent).not.toContain('\\n');
  });

  it('含代码围栏的文本不动（围栏里的 \\n 可能是真代码）', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(7624515600, { onEnd: () => {} });
    const code = '看这段：```js\nconsole.log("a\\nb");```';
    await host.telegram.sendText(code);
    // 分句器会按行/标点拆成多气泡（既有行为）。归一化若误伤围栏内容，字面 \n
    // 会变成真换行被进一步拆散——只要还有完整 `console.log("a\nb")` 片段即未动。
    const joined = sendMessage.mock.calls.map((c) => String(c[1])).join('');
    expect(joined).toContain('console.log("a\\nb")');
  });

  it('DM: no default reply_to; explicit still works', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(7624515600, { onEnd: () => {}, defaultReplyTo: 99 });
    await host.telegram.sendText('嗨');
    expect(sendMessage.mock.calls[0]![2]).toBeUndefined();
    await host.telegram.sendText('强调这句', 99);
    expect(sendMessage.mock.calls[1]![2]).toBe(99);
  });

  it('group: omitting replyTo no longer auto-fills task quote (2026-08-22 起引用有指向才用)', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(-100123, { onEnd: () => {}, defaultReplyTo: 77, quoteIds: [77] });
    await host.telegram.sendText('第一条');
    await host.telegram.sendText('第二条');
    expect(sendMessage.mock.calls[0]![2]).toBeUndefined();
    expect(sendMessage.mock.calls[1]![2]).toBeUndefined();
  });

  it('group: explicit replyTo honored within task quotes, rejected outside', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    // burst：任务 quotes 有两条（77/88），分人各回各的
    const host = createHostApi(-100123, { onEnd: () => {}, defaultReplyTo: 77, quoteIds: [77, 88], maxTextSends: 5 });
    await host.telegram.sendText('回 77 这句', 77);
    await host.telegram.sendText('回 88 那句', 88);
    expect(sendMessage.mock.calls[0]![2]).toBe(77);
    expect(sendMessage.mock.calls[1]![2]).toBe(88);
    // quotes 之外的旧 id → 拦（串台防护）
    await expect(host.telegram.sendText('贴错人', 999)).rejects.toThrow(/reply_to_mismatch/);
  });

  it('group: segmenter splits — no part quotes unless model explicitly asks', async () => {
    const { createHostApi } = await import('../../../src/subagent/host-api.js');
    const host = createHostApi(-100123, { onEnd: () => {}, defaultReplyTo: 77, quoteIds: [77] });
    // >20 chars + 句号 → host runs segmentReply
    await host.telegram.sendText('先看看温度是不是瓶颈吧。别真把小机子给烤熟了喵。别瞎超频！');
    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    for (let i = 0; i < sendMessage.mock.calls.length; i++) {
      expect(sendMessage.mock.calls[i]![2]).toBeUndefined();
    }
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
