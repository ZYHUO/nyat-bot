import { describe, expect, it, vi } from 'vitest';

const sendMessage = vi.fn(async () => 101);
const sendChatAction = vi.fn(async () => undefined);
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage, sendChatAction }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn(), hget: vi.fn() }) }));
vi.mock('../../../src/env.js', () => ({ env: () => ({
  BOT_TOKEN: 'x', BOT_USERNAME: 'bot', REDIS_URL: 'redis://127.0.0.1:6379/0', SQLITE_PATH: ':memory:',
  SANDBOX_ENABLED: false, CODEACT_BANNED_WORDS: [], PROMISE_LOOP_ENABLED: false,
  REPLY_HUMANIZER_SAFE_MODE: true,
}) }));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [] }) }) }));
vi.mock('../../../src/metrics/social-ledger.js', () => ({ recordReplySent: vi.fn() }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ addAssistant: vi.fn(async () => undefined) }));
vi.mock('../../../src/memory/chroma.js', () => ({ memorizeMessage: vi.fn(async () => undefined) }));
vi.mock('../../../src/meta/timing-adapter.js', () => ({ noteMetaBotReply: vi.fn(async () => undefined) }));
vi.mock('../../../src/subagent/post-task-window.js', () => ({ noteBotSpoke: vi.fn() }));

const { createHostApi } = await import('../../../src/subagent/host-api.js');

describe('delivery lifecycle', () => {
  it('keeps intermediate delivery separate from final delivery', async () => {
    const host = createHostApi(-100123, { onEnd: vi.fn(), taskId: 'task-lifecycle', defaultReplyTo: 77, quoteIds: [77] });
    await host.telegram.sendText('发现了一个矛盾，先核对一下', 77, 'discovery');
    expect(host.runtime.didSendText()).toBe(true);
    expect(host.runtime.didSendIntermediate()).toBe(true);
    expect(host.runtime.didProduceFinal()).toBe(false);
    expect(host.runtime.lastDeliveryKind()).toBe('discovery');

    await host.telegram.sendFinal('核对好了，最终结果在这里', 77);
    expect(host.runtime.didProduceFinal()).toBe(true);
    expect(host.runtime.lastDeliveryKind()).toBe('final');
  });

  it('waitForUser marks waiting without finalizing', () => {
    const host = createHostApi(-100123, { onEnd: vi.fn(), taskId: 'task-wait' });
    host.runtime.waitForUser('需要确认目标环境');
    expect(host.runtime.isWaitingForUser()).toBe(true);
    expect(host.runtime.waitingReason()).toBe('需要确认目标环境');
    expect(host.runtime.didProduceFinal()).toBe(false);
  });
});
