import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FormattedMessage } from '../../../src/shared/types.js';

vi.mock('../../../src/env.js', () => {
  const e: Record<string, unknown> = { BOT_DELEGATION_ENABLED: true, BOT_DELEGATION_COOLDOWN_SEC: 60, BOT_NICKNAMES: ['本喵'], BOT_USERNAME: 'hunhebi_bot' };
  return { env: () => e, _e: e };
});
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string, ...a: unknown[]) => { if (a.includes('NX') && store.has(k)) return null; store.set(k, v); return 'OK'; }),
  del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const sendMessage = vi.fn(async () => 12345);
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));

let profile: Record<string, unknown> | undefined;
let why: string | null = null;
vi.mock('../../../src/learners/bot-command-store.js', () => ({
  getCommandProfile: () => profile,
  whyNotInvocable: () => why,
}));

// receipt answer 的下游(只验证"有没有触发回复"层面)
const ctxAdd = vi.fn(async () => {});
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: vi.fn(async () => [{ messageId: 1, textContent: '股价多少', uid: 1, isBot: false }]),
  addAssistant: (...a: unknown[]) => ctxAdd(...a),
}));
vi.mock('../../../src/pipeline/context/slim.js', () => ({ slimContextForAI: () => 'CTX' }));
vi.mock('../../../src/pipeline/reply/prompt-builder.js', () => ({ buildSystemPrompt: () => 'SYS' }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn(async () => ({ content: '{"replyContent":"查到啦,8.8.8.8 在美国喵"}' })) }));
vi.mock('../../../src/pipeline/reply/parser.js', () => ({ parseReplyResponse: () => [{ replyContent: '查到啦,8.8.8.8 在美国喵' }] }));

const { _e: envVals } = (await import('../../../src/env.js')) as unknown as { _e: Record<string, unknown> };
const { executeUseBotCommand, tryHandleDelegationReceipt, maybeRegisterTypedDelegation, PENDING_KEY } = await import('../../../src/pipeline/tools/bot-delegation.js');

function bmsg(o: Partial<FormattedMessage>): FormattedMessage {
  return { role: 'user', uid: 5, username: 'b', fullName: 'B', timestamp: 1, messageId: 9, textContent: '', isForwarded: false, isBot: true, ...o } as FormattedMessage;
}

beforeEach(() => {
  store.clear(); profile = undefined; why = null;
  envVals['BOT_DELEGATION_ENABLED'] = true;
  vi.clearAllMocks();
});

describe('executeUseBotCommand 安全门', () => {
  it('flag 关 → 不发,提示教用户', async () => {
    envVals['BOT_DELEGATION_ENABLED'] = false;
    const r = await executeUseBotCommand(-100, 'geo', '/geo', '8.8.8.8');
    expect(r).toMatch(/没开|自己发/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('不可代发(needs_admin)→ 返回原因 + 教用户,不发命令', async () => {
    profile = { usage_syntax: '/ban <user>' }; why = 'needs_admin';
    const r = await executeUseBotCommand(-100, 'paimeng_ban_bot', '/ban', 'x');
    expect(r).toMatch(/管理员/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('可代发 → 发 @指向命令 + 登记 pending + 过渡指示', async () => {
    profile = { usage_syntax: '/geo <IP>' }; why = null;
    const r = await executeUseBotCommand(-100, 'uzumaru_geoip_bot', '/geo', '8.8.8.8');
    expect(sendMessage).toHaveBeenCalledWith(-100, '/geo@uzumaru_geoip_bot 8.8.8.8');
    expect(store.has(PENDING_KEY(-100))).toBe(true);
    expect(r).toMatch(/不要编造|过渡话|我帮你问问/);
  });

  it('限速:刚发过 → 拒绝第二次', async () => {
    profile = {}; why = null;
    await executeUseBotCommand(-100, 'b', '/geo', 'a');
    sendMessage.mockClear();
    // 第二次:cooldown 键已存在 → NX 失败
    const r = await executeUseBotCommand(-100, 'b', '/geo', 'a');
    expect(r).toMatch(/缓一下|别刷屏/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('已有 pending 时调用 → 不发、且不烧冷却(review #4)', async () => {
    profile = {}; why = null;
    store.set(PENDING_KEY(-100), JSON.stringify({ bot: 'x', command: '/y', args: '', sentMid: 1, issuedAt: 1 }));
    const r = await executeUseBotCommand(-100, 'b', '/geo', 'a');
    expect(r).toMatch(/还在等回执/);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.has('xxb:delegation:cd:-100')).toBe(false); // 冷却没被烧
  });

  it('私聊 → 拒绝', async () => {
    const r = await executeUseBotCommand(100, 'b', '/geo', 'a');
    expect(r).toMatch(/私聊/);
  });
});

describe('tryHandleDelegationReceipt 回执处理', () => {
  function setPending() { store.set(PENDING_KEY(-100), JSON.stringify({ bot: 'uzumaru_geoip_bot', command: '/geo', args: '8.8.8.8', sentMid: 1, issuedAt: 1 })); }

  it('flag 关 → 不处理', async () => {
    envVals['BOT_DELEGATION_ENABLED'] = false; setPending();
    expect(await tryHandleDelegationReceipt(-100, bmsg({ username: 'uzumaru_geoip_bot', textContent: 'IP: ...' }), 9999)).toBe(false);
  });

  it('非目标 bot 且无关联 → 不处理', async () => {
    setPending();
    expect(await tryHandleDelegationReceipt(-100, bmsg({ username: 'other_bot', textContent: 'hi' }), 9999)).toBe(false);
  });

  it('配套下载 bot 代发、正文带 "via @目标bot" → 认领(CloudMusicDownloader 真实案例)', async () => {
    store.set(PENDING_KEY(-100), JSON.stringify({ bot: 'Music163bot', command: '/music', args: '晴天', sentMid: 1, issuedAt: 1 }));
    const r = await tryHandleDelegationReceipt(-100, bmsg({
      username: 'CloudMusicDownloader',
      textContent: '「晴天」- 周杰伦\nflac 53MB\nvia @Music163bot',
    }), 9999);
    expect(r).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('经 inline(viaBot=目标bot)发出 → 认领', async () => {
    store.set(PENDING_KEY(-100), JSON.stringify({ bot: 'Music163bot', command: '/music', args: '晴天', sentMid: 1, issuedAt: 1 }));
    const r = await tryHandleDelegationReceipt(-100, bmsg({ username: 'SomeUserBot', viaBot: 'Music163bot', textContent: '晴天 - 周杰伦' }), 9999);
    expect(r).toBe(true);
  });

  it('进度占位(⏳ Querying)→ 不消费,继续等', async () => {
    setPending();
    const r = await tryHandleDelegationReceipt(-100, bmsg({ username: 'uzumaru_geoip_bot', textContent: '⏳ Querying all APIs...' }), 9999);
    expect(r).toBe(false);
    expect(store.has(PENDING_KEY(-100))).toBe(true); // pending 还在
  });

  it('只有按钮无正文(可能占位)→ 不消费、继续等(review #5)', async () => {
    setPending();
    const r = await tryHandleDelegationReceipt(-100, bmsg({ username: 'uzumaru_geoip_bot', textContent: '', inlineKeyboard: [{ text: '确认身份', callbackData: 'x' }] }), 9999);
    expect(r).toBe(false);
    expect(store.has(PENDING_KEY(-100))).toBe(true); // pending 保留,等后续真结果
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('媒体回执无正文 → 消费 + 致意(不答"没查到",review #6)', async () => {
    setPending();
    const r = await tryHandleDelegationReceipt(-100, bmsg({ username: 'uzumaru_geoip_bot', textContent: '', audioFileId: 'aud123' }), 9999);
    expect(r).toBe(true);
    expect(store.has(PENDING_KEY(-100))).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('长进度句(>40字)→ 仍识别为占位,继续等(review #9)', async () => {
    setPending();
    const long = '正在查询您请求的IP地址归属信息以及相关的网络服务商数据,请稍候片刻马上就好';
    const r = await tryHandleDelegationReceipt(-100, bmsg({ username: 'uzumaru_geoip_bot', textContent: long }), 9999);
    expect(r).toBe(false);
    expect(store.has(PENDING_KEY(-100))).toBe(true);
  });

  it('最终文本结果 → 消费 + 清 pending + 生成回复', async () => {
    setPending();
    const r = await tryHandleDelegationReceipt(-100, bmsg({ username: 'uzumaru_geoip_bot', textContent: 'IP: 8.8.8.8 ASN Google US' }), 9999);
    expect(r).toBe(true);
    expect(store.has(PENDING_KEY(-100))).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]![1])).toMatch(/查到/);
  });
});

describe('maybeRegisterTypedDelegation(模型直接打命令也能接回执)', () => {
  it('回复就是 /cmd@bot → 补登记 pending', async () => {
    await maybeRegisterTypedDelegation(-100, '/music@Music163bot 晴天', 555);
    const raw = store.get(PENDING_KEY(-100));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toMatchObject({ bot: 'Music163bot', command: '/music', args: '晴天', sentMid: 555 });
  });

  it('解释性提到命令(不在开头)→ 不登记', async () => {
    await maybeRegisterTypedDelegation(-100, '你可以发 /music@Music163bot 晴天 试试', 555);
    expect(store.has(PENDING_KEY(-100))).toBe(false);
  });

  it('已有 pending → 不覆盖', async () => {
    store.set(PENDING_KEY(-100), JSON.stringify({ bot: 'x', command: '/y', args: '', sentMid: 1, issuedAt: 1 }));
    await maybeRegisterTypedDelegation(-100, '/music@Music163bot 晴天', 555);
    expect(JSON.parse(store.get(PENDING_KEY(-100))!).bot).toBe('x');
  });

  it('flag 关 → 不登记', async () => {
    envVals['BOT_DELEGATION_ENABLED'] = false;
    await maybeRegisterTypedDelegation(-100, '/music@Music163bot 晴天', 555);
    expect(store.has(PENDING_KEY(-100))).toBe(false);
  });

  it('@自己 → 不登记', async () => {
    await maybeRegisterTypedDelegation(-100, '/help@hunhebi_bot', 555);
    expect(store.has(PENDING_KEY(-100))).toBe(false);
  });
});
