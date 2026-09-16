import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

vi.mock('../../../src/env.js', () => {
  const e: Record<string, unknown> = { PEER_REACTION_ENABLED: true, BOT_USERNAME: 'hunhebi_bot', BOT_NICKNAMES: ['本喵', '啾咪囝'] };
  return { env: () => e, _e: e };
});
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  incr: vi.fn(async (k: string) => { const n = parseInt(store.get(k) ?? '0', 10) + 1; store.set(k, String(n)); return n; }),
  expire: vi.fn(async () => 1),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../src/tracking/sleep.js', () => ({ isAsleep: vi.fn(async () => false) }));
vi.mock('../../../src/queue/chat-lock.js', () => ({ acquireChatLock: vi.fn(async () => vi.fn(async () => {})) }));
vi.mock('../../../src/pipeline/timing/chat-runtime.js', () => ({ isChatSuppressed: vi.fn(async () => false) }));
const sendMessage = vi.fn(async () => 999);
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ addAssistant: vi.fn(async () => {}) }));
let genReturn: string | null = '千雪又在装了喵';
vi.mock('../../../src/pipeline/turn/proactive-turn.js', () => ({ generatePersonaProactiveText: vi.fn(async () => genReturn) }));

const { _e: envVals } = (await import('../../../src/env.js')) as unknown as { _e: Record<string, unknown> };
const { maybePeerReaction } = await import('../../../src/pipeline/games/peer-reaction.js');

const BOT_UID = 9999;
function peer(o: Partial<FormattedMessage>): FormattedMessage {
  return { role: 'user', uid: 5, username: 'qianxue_bot', fullName: '千雪', timestamp: 1, messageId: 1, textContent: '数学鬼才是吧', isForwarded: false, isBot: true, botClass: 'chat', ...o } as FormattedMessage;
}

beforeEach(() => {
  store.clear(); genReturn = '千雪又在装了喵';
  envVals['PEER_REACTION_ENABLED'] = true;
  vi.clearAllMocks();
  vi.spyOn(Math, 'random').mockReturnValue(0); // 过概率门
});

describe('maybePeerReaction', () => {
  it('chat 类(千雪)→ 生成并发出反应', async () => {
    await maybePeerReaction(-100, peer({}), BOT_UID);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]![1])).toContain('千雪');
  });

  it('flag 关 → 不动', async () => {
    envVals['PEER_REACTION_ENABLED'] = false;
    await maybePeerReaction(-100, peer({}), BOT_UID);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('@/回复我 → 让位(不双答)', async () => {
    await maybePeerReaction(-100, peer({ replyTo: { messageId: 1, uid: BOT_UID, fullName: 'me', textSnippet: 'x' } }), BOT_UID);
    expect(sendMessage).not.toHaveBeenCalled();
    await maybePeerReaction(-100, peer({ textContent: '@hunhebi_bot 在吗' }), BOT_UID);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('有未决代发 → 不插嘴', async () => {
    store.set('xxb:delegation:-100', '{}');
    await maybePeerReaction(-100, peer({}), BOT_UID);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('cmd_result 无媒体 → 不尾刀;有媒体 → 尾刀', async () => {
    await maybePeerReaction(-100, peer({ username: 'jiexiji', fullName: '聚合解析姬', botClass: 'cmd_result', textContent: '解析中...' }), BOT_UID);
    expect(sendMessage).not.toHaveBeenCalled();
    await maybePeerReaction(-100, peer({ username: 'jiexiji', fullName: '聚合解析姬', botClass: 'cmd_result', textContent: '', videoFileId: 'v1' }), BOT_UID);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('per-peer fatigue:同一 bot 超 3 次不再反应', async () => {
    for (let i = 0; i < 3; i++) { await maybePeerReaction(-100, peer({}), BOT_UID); store.delete('xxb:peerreact:cd:-100'); }
    expect(sendMessage).toHaveBeenCalledTimes(3);
    await maybePeerReaction(-100, peer({}), BOT_UID); // 第 4 次:fatigue 超限
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it('全局冷却内 → 不反应', async () => {
    await maybePeerReaction(-100, peer({}), BOT_UID);
    await maybePeerReaction(-100, peer({ username: 'otherbot', fullName: '别的猫', botClass: 'chat' }), BOT_UID);
    expect(sendMessage).toHaveBeenCalledTimes(1); // 第二次被全局冷却挡
  });

  it('模型 silent(返回 null)→ 不发', async () => {
    genReturn = null;
    await maybePeerReaction(-100, peer({}), BOT_UID);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('botClass 非 chat/cmd_result → 不动', async () => {
    await maybePeerReaction(-100, peer({ botClass: 'ad' }), BOT_UID);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
