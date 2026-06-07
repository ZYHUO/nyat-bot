import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const envState = {
  TURN_SELF_FOLLOWUP_ENABLED: true,
  TURN_SELF_FOLLOWUP_MAX: 2,
};

const {
  callMock, sendMessageMock, sendStickerMock, sendChatActionMock,
  addAssistantMock, getRecentMock, pendingCountMock, redisGetMock, redisSetMock,
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  sendMessageMock: vi.fn(async () => 777),
  sendStickerMock: vi.fn(async () => 778),
  sendChatActionMock: vi.fn(async () => {}),
  addAssistantMock: vi.fn(async () => {}),
  getRecentMock: vi.fn(async (): Promise<unknown[]> => []),
  pendingCountMock: vi.fn(async () => 0),
  redisGetMock: vi.fn(async (): Promise<string | null> => null),
  redisSetMock: vi.fn(async () => 'OK'),
}));

vi.mock('../../../src/env.js', () => ({ env: () => envState }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: getRecentMock,
  addAssistant: addAssistantMock,
}));
vi.mock('../../../src/pipeline/context/slim.js', () => ({
  slimContextForAI: vi.fn(() => 'CTX'),
}));
vi.mock('../../../src/pipeline/reply/prompt-builder.js', () => ({
  buildSystemPrompt: vi.fn(() => 'SYSTEM'),
}));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: callMock }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: sendMessageMock,
  sendSticker: sendStickerMock,
  sendChatAction: sendChatActionMock,
}));
vi.mock('../../../src/knowledge/sticker/store.js', () => ({
  getReadyStickersByIntent: vi.fn(() => [{ fileId: 'f', fileUniqueId: 'u', score: 1 }]),
  recordStickerSent: vi.fn(),
}));
vi.mock('../../../src/pipeline/turn/buffer.js', () => ({ pendingCount: pendingCountMock }));
vi.mock('../../../src/pipeline/timing/state-store.js', () => ({
  recordBotReply: vi.fn(async () => {}),
}));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({
  isChatSuppressed: vi.fn(async () => false),
}));
vi.mock('../../../src/queue/chat-lock.js', () => ({
  acquireChatLock: vi.fn(async () => vi.fn(async () => {})),
}));
vi.mock('../../../src/db/redis.js', () => ({
  getRedis: () => ({ get: redisGetMock, set: redisSetMock }),
}));

import { maybeSelfContinue } from '../../../src/pipeline/turn/self-continue.js';
import { _resetAbortRegistry } from '../../../src/pipeline/turn/abort-registry.js';

const CHAT = -100950;
const BOT_UID = 9999;

function botMsg(messageId: number, textContent = '本喵在等主人投喂呀') {
  return { role: 'assistant', uid: BOT_UID, messageId, textContent, timestamp: 0 };
}

let randomSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0); // pass all probability gates, zero jitter
  callMock.mockReset();
  sendMessageMock.mockClear();
  sendStickerMock.mockClear();
  addAssistantMock.mockClear();
  redisGetMock.mockReset().mockResolvedValue(null);
  redisSetMock.mockClear();
  pendingCountMock.mockReset().mockResolvedValue(0);
  getRecentMock.mockReset().mockResolvedValue([botMsg(1), botMsg(2)]);
  envState.TURN_SELF_FOLLOWUP_ENABLED = true;
  _resetAbortRegistry();
});

afterEach(() => {
  randomSpy.mockRestore();
  vi.useRealTimers();
});

async function run(): Promise<void> {
  const p = maybeSelfContinue(CHAT, BOT_UID);
  await vi.runAllTimersAsync();
  await p;
}

describe('G6 self-continuation', () => {
  it('sends a short follow-up when the model offers one, then sets the cooldown', async () => {
    callMock
      .mockResolvedValueOnce({ content: '{"replyContent":"对了，刚才那个其实还有个坑","targetMessageId":2}' })
      .mockResolvedValue({ content: '{"action":"silent"}' });

    await run();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]![1]).toContain('对了');
    expect(addAssistantMock).toHaveBeenCalledTimes(1);
    expect(redisSetMock).toHaveBeenCalled(); // cooldown armed only after sending
  });

  it('does nothing when the model chooses silence', async () => {
    callMock.mockResolvedValue({ content: '{"action":"silent"}' });
    await run();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('yields to pending user messages before calling the LLM', async () => {
    pendingCountMock.mockResolvedValue(1);
    await run();
    expect(callMock).not.toHaveBeenCalled();
  });

  it('yields when someone replied after the bot (last message not ours)', async () => {
    getRecentMock.mockResolvedValue([botMsg(1), { role: 'user', uid: 1, messageId: 3, textContent: 'hi', timestamp: 0 }]);
    await run();
    expect(callMock).not.toHaveBeenCalled();
  });

  it('respects the per-chat cooldown', async () => {
    redisGetMock.mockResolvedValue('1');
    await run();
    expect(callMock).not.toHaveBeenCalled();
  });

  it('flag off → fully inert', async () => {
    envState.TURN_SELF_FOLLOWUP_ENABLED = false;
    await run();
    expect(callMock).not.toHaveBeenCalled();
  });

  it('sticker follow-up goes through the sticker sender', async () => {
    callMock
      .mockResolvedValueOnce({ content: '[{"action":"sticker","stickerIntent":["laughing"]}]' })
      .mockResolvedValue({ content: '{"action":"silent"}' });

    await run();

    expect(sendStickerMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(addAssistantMock).toHaveBeenCalledWith(CHAT, { textContent: '[sticker]', messageId: 778 });
  });

  it('re-answer guard: drops a follow-up that opens like the bot own last reply', async () => {
    // 线上事故指纹:两条都以"还没"开头(换皮重答)
    getRecentMock.mockResolvedValue([botMsg(1, '还没呢，本喵在等主人投喂呀~ 主人吃过啦？'), botMsg(2, '还没呢，本喵在等主人投喂呀~ 主人吃过啦？')]);
    callMock.mockResolvedValueOnce({ content: '{"replyContent":"还没呢主人，本喵刚醒就被抓来营业了喵","targetMessageId":2}' });

    await run();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('re-answer guard: drops a near-duplicate follow-up (bigram similarity)', async () => {
    getRecentMock.mockResolvedValue([botMsg(1, '这个方案本喵觉得挺靠谱的可以先试试看'), botMsg(2, '这个方案本喵觉得挺靠谱的可以先试试看')]);
    callMock.mockResolvedValueOnce({ content: '{"replyContent":"嗯这个方案本喵觉得挺靠谱可以先试试","targetMessageId":2}' });

    await run();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('re-answer guard: genuinely new content still goes out', async () => {
    getRecentMock.mockResolvedValue([botMsg(1, '还没呢，本喵在等主人投喂呀~'), botMsg(2, '还没呢，本喵在等主人投喂呀~')]);
    callMock
      .mockResolvedValueOnce({ content: '{"replyContent":"对了主人记得帮本喵带杯豆浆","targetMessageId":2}' })
      .mockResolvedValue({ content: '{"action":"silent"}' });

    await run();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it('drops the follow-up if users spoke during generation', async () => {
    callMock.mockResolvedValueOnce({ content: '{"replyContent":"补一句","targetMessageId":2}' });
    pendingCountMock
      .mockResolvedValueOnce(0) // pre-LLM check
      .mockResolvedValue(1);    // post-LLM check → yield
    await run();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
