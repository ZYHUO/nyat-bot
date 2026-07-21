import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/env.js', () => ({
  env: () => ({
    DREAM_JOURNAL_ENABLED: true,
    DREAM_JOURNAL_DIR: '/tmp/nyat-dream-journal-test',
    DREAM_JOURNAL_DM: false,
    DREAM_JOURNAL_CHAT_ID: 0,
    DREAM_JOURNAL_USAGE: 'summarize',
    MASTER_UID: 0,
  }),
}));

vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: vi.fn(async () => ({
    content: '今天本喵在群里划水，顺便嫌弃了两句笨蛋。明天继续上课偷瞄手机。',
    label: 'mock',
  })),
}));

vi.mock('../../../src/meta/global-state.js', () => ({
  getGlobalState: () => ({
    recentDigests: () => [{ at: Date.now(), text: 'dispatched L0 reply' }],
  }),
}));

describe('dream-journal', () => {
  beforeEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm('/tmp/nyat-dream-journal-test', { recursive: true, force: true });
  });

  it('writes a markdown diary file', async () => {
    const { runDreamJournal, dreamJournalPath, normalizeJournalChatId } = await import('../../../src/cron/dream-journal.js');
    expect(normalizeJournalChatId(3954993432)).toBe(-1003954993432);
    const path = await runDreamJournal();
    expect(path).toBeTruthy();
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(dreamJournalPath(), 'utf8');
    expect(body).toContain('本喵');
    expect(body.startsWith('# ')).toBe(true);
  });
});
