import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/env.js', () => ({
  env: () => ({
    DREAM_JOURNAL_ENABLED: true,
    DREAM_JOURNAL_DIR: '/tmp/nyat-dream-journal-test',
    DREAM_JOURNAL_DM: false,
    DREAM_JOURNAL_CHAT_ID: 0,
    DREAM_JOURNAL_USAGE: 'summarize',
    DREAM_JOURNAL_HOOK_SLEEP: true,
    MASTER_UID: 7624515600,
  }),
}));

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: vi.fn(async (opts: { messages: Array<{ role: string; content: string }> }) => {
    const user = opts.messages.find((m) => m.role === 'user');
    expect(user?.content).toContain('签到');
    expect(user?.content).toMatch(/WRITE|SKIP|时段暗示/);
    return {
      content:
        'WRITE\n\n今天本喵在群里划水，顺便嫌弃了两句笨蛋。明天继续上课偷瞄手机。',
      label: 'mock',
    };
  }),
}));

vi.mock('../../../src/meta/global-state.js', () => ({
  getGlobalState: () => ({
    recentDigests: () => [{ at: Date.now(), text: 'dispatched L0 reply' }],
  }),
}));

vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    zrange: async () => ['-1003184176508'],
    lrange: async () => [],
    set: async () => 'OK',
    get: async () => null,
    del: async () => 1,
  }),
}));

vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: async () => [
    {
      role: 'user',
      uid: 1,
      username: 'u',
      fullName: '测试员',
      timestamp: Math.floor(Date.now() / 1000),
      messageId: 1,
      textContent: '签到成功啦',
      isForwarded: false,
    },
    {
      role: 'assistant',
      uid: 0,
      username: '',
      fullName: '',
      timestamp: Math.floor(Date.now() / 1000),
      messageId: 2,
      textContent: '哼，知道了',
      isForwarded: false,
    },
  ],
}));

vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: vi.fn(async () => 1),
}));

describe('dream-journal', () => {
  beforeEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm('/tmp/nyat-dream-journal-test', { recursive: true, force: true });
  });

  it('appends a markdown diary entry when model says WRITE', async () => {
    const { runDreamJournal, dreamJournalPath, normalizeJournalChatId } = await import(
      '../../../src/cron/dream-journal.js'
    );
    expect(normalizeJournalChatId(3954993432)).toBe(-1003954993432);
    const path = await runDreamJournal({ slot: 'bedtime' });
    expect(path).toBeTruthy();
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(dreamJournalPath(), 'utf8');
    expect(body).toContain('本喵');
    expect(body.startsWith('# ')).toBe(true);
    expect(body).toMatch(/^## /m);
  });

  it('skips when model says SKIP', async () => {
    const { callWithFallback } = await import('../../../src/ai/fallback.js');
    vi.mocked(callWithFallback).mockResolvedValueOnce({
      content: 'SKIP 今天没啥好写的',
      label: 'mock',
    } as never);
    const { runDreamJournal } = await import('../../../src/cron/dream-journal.js');
    const path = await runDreamJournal({ slot: 'morning' });
    expect(path).toBeNull();
  });

  it('tryWriteDreamJournal force writes via journal path', async () => {
    const { tryWriteDreamJournal } = await import('../../../src/cron/dream-journal.js');
    const r = await tryWriteDreamJournal({ slot: 'free', force: true });
    expect(r.wrote).toBe(true);
    expect(r.path).toBeTruthy();
    expect(r.slot).toBe('free');
  });
});
