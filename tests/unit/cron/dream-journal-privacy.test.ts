import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const testDir = '/tmp/nyat-dream-journal-privacy-test';
const config = {
  DREAM_JOURNAL_ENABLED: true,
  DREAM_JOURNAL_DIR: testDir,
  DREAM_JOURNAL_DM: false,
  DREAM_JOURNAL_CHAT_ID: 0,
  DREAM_JOURNAL_USAGE: 'summarize',
  MASTER_UID: 42,
};
const call = vi.fn();
const getRecent = vi.fn();
const send = vi.fn();
const setRedis = vi.fn(async (..._args: unknown[]) => 'OK');
let localDigests: Array<{ at: number; text: string; sourceChatId?: number }> = [];
let redisDigests: string[] = [];

vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: (...args: unknown[]) => call(...args) }));
vi.mock('../../../src/meta/global-state.js', () => ({
  getGlobalState: () => ({ recentDigests: () => localDigests }),
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({
    lrange: async () => redisDigests,
    set: (...args: unknown[]) => setRedis(...args),
  }),
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: (...args: unknown[]) => getRecent(...args) }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: (...args: unknown[]) => send(...args) }));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: vi.fn() }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const {
  dreamJournalPath, readRecentDreamSnippet, runDreamJournal, tryWriteDreamJournal,
} = await import('../../../src/cron/dream-journal.js');

function message(text: string) {
  return { role: 'user', uid: 7, textContent: text, timestamp: Math.floor(Date.now() / 1000) };
}

beforeEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  vi.clearAllMocks();
  Object.assign(config, { MASTER_UID: 42, DREAM_JOURNAL_DM: false, DREAM_JOURNAL_CHAT_ID: 0 });
  localDigests = [];
  redisDigests = [];
  getRecent.mockImplementation(async (chatId: number) => [message(`source ${chatId} today's discussion`)]);
  call.mockResolvedValue({ content: 'WRITE\n\n本喵记下这个会话里今天聊到的小事，听大家说话也很开心。', label: 'mock' });
  send.mockResolvedValue(1);
});
afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

describe('dream journal provenance', () => {
  it('reads only the requested chat and never broadcasts its diary to another channel or owner DM', async () => {
    config.DREAM_JOURNAL_CHAT_ID = -200;
    config.DREAM_JOURNAL_DM = true;
    const path = await runDreamJournal({ sourceChatId: -100 });
    expect(path).toBe(dreamJournalPath(undefined, { sourceChatId: -100 }));
    expect(getRecent).toHaveBeenCalledTimes(1);
    expect(getRecent).toHaveBeenCalledWith(-100, 60);
    expect(send).not.toHaveBeenCalled();
    expect(await readRecentDreamSnippet(400, { sourceChatId: -100 })).toContain('本喵');
    expect(await readRecentDreamSnippet(400, { sourceChatId: -200 })).toBeNull();
    expect(await readRecentDreamSnippet(400, { sourceChatId: 42 })).toBeNull();
    expect(await readRecentDreamSnippet()).toBeNull();
  });

  it('excludes foreign and unlabelled memory/Redis digests before the diary model sees them', async () => {
    localDigests = [
      { at: Date.now(), sourceChatId: -100, text: 'LOCAL_ALLOWED' },
      { at: Date.now(), sourceChatId: 42, text: 'LOCAL_DM_SECRET' },
      { at: Date.now(), text: 'LOCAL_UNKNOWN_SECRET' },
    ];
    redisDigests = [
      JSON.stringify({ at: Date.now(), sourceChatId: -100, text: 'REDIS_ALLOWED' }),
      JSON.stringify({ at: Date.now(), sourceChatId: -200, text: 'REDIS_OTHER_GROUP_SECRET' }),
      JSON.stringify({ at: Date.now(), text: 'REDIS_UNKNOWN_SECRET' }),
    ];
    await runDreamJournal({ sourceChatId: -100 });
    const prompt = JSON.stringify(call.mock.calls[0]![0]);
    expect(prompt).toContain('LOCAL_ALLOWED');
    expect(prompt).toContain('REDIS_ALLOWED');
    expect(prompt).not.toContain('SECRET');
  });

  it('keeps legacy and mismatched-source files intact without reading them into prompts or snippets', async () => {
    const legacyPath = dreamJournalPath();
    const scopedPath = dreamJournalPath(undefined, { sourceChatId: -100 });
    await mkdir(dirname(scopedPath), { recursive: true });
    const legacy = '# Old global diary\n\nLEGACY_DM_SECRET repeated private material.';
    const mismatched = '<!-- nyatbot-journal-source:v1:42 -->\n# Wrong source\n\nMISMATCHED_DM_SECRET';
    await writeFile(legacyPath, legacy);
    expect(await readRecentDreamSnippet(400, { sourceChatId: -100 })).toBeNull();
    await writeFile(scopedPath, mismatched);
    expect(await readRecentDreamSnippet(400, { sourceChatId: -100 })).toBeNull();
    const result = await tryWriteDreamJournal({ sourceChatId: -100, force: true });
    expect(result).toMatchObject({ wrote: false, reason: 'unverified_existing_source' });
    expect(call).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await readFile(legacyPath, 'utf8')).toBe(legacy);
    expect(await readFile(scopedPath, 'utf8')).toBe(mismatched);
  });

  it('defaults internal cron to the owner DM and permits delivery only back to that source', async () => {
    config.DREAM_JOURNAL_DM = true;
    config.DREAM_JOURNAL_CHAT_ID = -200;
    await runDreamJournal({ slot: 'morning' });
    expect(getRecent).toHaveBeenCalledTimes(1);
    expect(getRecent).toHaveBeenCalledWith(42, 60);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(42);
    expect(await readRecentDreamSnippet(400, { sourceChatId: 42 })).toContain('本喵');
  });

  it('rejects missing or invalid source rather than falling back to public evidence', async () => {
    config.MASTER_UID = 0;
    expect(await tryWriteDreamJournal({ force: true })).toMatchObject({ wrote: false, reason: 'missing_source_chat' });
    config.MASTER_UID = 42;
    expect(await tryWriteDreamJournal({ sourceChatId: 0, force: true })).toMatchObject({ wrote: false, reason: 'missing_source_chat' });
    expect(getRecent).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('isolates cooldown claims between conversations', async () => {
    await tryWriteDreamJournal({ sourceChatId: -100, slot: 'free' });
    await tryWriteDreamJournal({ sourceChatId: -200, slot: 'free' });
    const keys = setRedis.mock.calls.map((args) => String(args[0]));
    expect(keys.some((key) => key.startsWith('xxb:dream:meta-cd:-100:'))).toBe(true);
    expect(keys.some((key) => key.startsWith('xxb:dream:meta-cd:-200:'))).toBe(true);
  });
});
