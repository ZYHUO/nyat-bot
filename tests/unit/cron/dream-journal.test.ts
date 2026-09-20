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
    expect(user?.content).toMatch(/WRITE|SKIP|时段:/);
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
    expect(r.reason).toBe('wrote');
  });

  // 2026-09-21：`free`（随手）那一档以前**配置上永远走不到** —— 默认两个 cron 槽
  // 落在上海 07:00/23:00，按 inferDreamSlot() 分别算 morning/bedtime。而它的语气
  // 指引也是空的，模型拿不到"这不是日记"的提示。这里锁住两件事。
  describe('随手（free）那一档', () => {
    it('inferDreamSlot 把白天判成 free', async () => {
      const { inferDreamSlot } = await import('../../../src/cron/dream-journal.js');
      // 2026-09-21 12:00 上海 = 04:00 UTC
      expect(inferDreamSlot(new Date('2026-09-21T04:00:00Z'))).toBe('free');
      // 07:00 上海 = 23:00 UTC(前一天)
      expect(inferDreamSlot(new Date('2026-09-20T23:00:00Z'))).toBe('morning');
      // 23:00 上海 = 15:00 UTC
      expect(inferDreamSlot(new Date('2026-09-21T15:00:00Z'))).toBe('bedtime');
    });

    it('free 档的提示里写明"不是日记"和"可以只有两三句"', async () => {
      const { callWithFallback } = await import('../../../src/ai/fallback.js');
      vi.mocked(callWithFallback).mockResolvedValueOnce({
        content: 'WRITE\n\n刚刷到一个梗，本喵笑到打滚。',
        label: 'mock',
      } as never);
      const { runDreamJournal } = await import('../../../src/cron/dream-journal.js');
      await runDreamJournal({ slot: 'free' });
      const user = vi.mocked(callWithFallback).mock.calls.at(-1)![0].messages.find(
        (m) => m.role === 'user',
      );
      const content = String(user?.content ?? '');
      expect(content).toContain('随手');
      expect(content).toContain('不是日记');
      expect(content).toContain('两三句');
      // 不能把早/晚的日记语气带给随手档
      expect(content).not.toContain('醒来碎碎念');
      expect(content).not.toContain('收一天');
    });

    it('morning/bedtime 档各自带自己的语气指引', async () => {
      const { callWithFallback } = await import('../../../src/ai/fallback.js');
      const { runDreamJournal } = await import('../../../src/cron/dream-journal.js');
      vi.mocked(callWithFallback).mockResolvedValueOnce({
        content: 'WRITE\n\n早啊，本喵还没睡够。', label: 'mock',
      } as never);
      await runDreamJournal({ slot: 'morning' });
      let user = vi.mocked(callWithFallback).mock.calls.at(-1)![0].messages.find((m) => m.role === 'user');
      expect(String(user?.content)).toContain('醒来碎碎念');

      vi.mocked(callWithFallback).mockResolvedValueOnce({
        content: 'WRITE\n\n困死了，本喵先去睡。', label: 'mock',
      } as never);
      await runDreamJournal({ slot: 'bedtime' });
      user = vi.mocked(callWithFallback).mock.calls.at(-1)![0].messages.find((m) => m.role === 'user');
      expect(String(user?.content)).toContain('收一天');
    });
  });

  it('parseDiaryDecision tolerates fences, chatter, and Chinese skip', async () => {
    const { parseDiaryDecision } = await import('../../../src/cron/dream-journal.js');
    expect(parseDiaryDecision('```\nWRITE\n\n本喵今天划水。\n```')).toMatchObject({
      action: 'WRITE',
      body: expect.stringContaining('本喵'),
    });
    expect(
      parseDiaryDecision('先想一下……\n\n**WRITE**\n\n群里有人签到，本喵困得要命。'),
    ).toMatchObject({ action: 'WRITE' });
    expect(parseDiaryDecision('SKIP：没什么新事')).toMatchObject({
      action: 'SKIP',
      reason: expect.stringContaining('没什么'),
    });
    expect(parseDiaryDecision('跳过，今天不想写')).toMatchObject({ action: 'SKIP' });
    expect(parseDiaryDecision('好的收到')).toMatchObject({ action: 'SKIP', reason: 'unparsed' });
  });

  it('parseDiaryDecision does not treat skip-intent sentences as implicit WRITE', async () => {
    const { parseDiaryDecision } = await import('../../../src/cron/dream-journal.js');
    // A sentence that says "nothing to write about, won't write" but lacks the
    // exact SKIP keyword — old code matched 本喵|今天 and saved it as diary body.
    expect(parseDiaryDecision('今天没什么好写的，本喵就不写了')).toMatchObject({
      action: 'SKIP',
    });
    expect(parseDiaryDecision('今天没素材，本喵不想写日记了')).toMatchObject({
      action: 'SKIP',
    });
    expect(parseDiaryDecision('算了不写了，今天群里没啥动静')).toMatchObject({
      action: 'SKIP',
    });
  });

  it('parseDiaryDecision still recognizes genuine implicit WRITE', async () => {
    const { parseDiaryDecision } = await import('../../../src/cron/dream-journal.js');
    // First-person narration without header should still be WRITE (≥40 chars,
    // no skip keywords).
    expect(
      parseDiaryDecision(
        '本喵今天在群里看到有人签到，觉得挺有趣的，大家都在聊周末的计划。睡前碎碎念一下。',
      ),
    ).toMatchObject({ action: 'WRITE', reason: 'implicit_write' });
  });
});
