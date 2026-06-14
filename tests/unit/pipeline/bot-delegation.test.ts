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
const { executeUseBotCommand, tryHandleDelegationReceipt, PENDING_KEY } = await import('../../../src/pipeline/tools/bot-delegation.js');

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

  it('非目标 bot → 不处理', async () => {
    setPending();
    expect(await tryHandleDelegationReceipt(-100, bmsg({ username: 'other_bot', textContent: 'hi' }), 9999)).toBe(false);
  });

  it('进度占位(⏳ Querying)→ 不消费,继续等', async () => {
    setPending();
    const r = await tryHandleDelegationReceipt(-100, bmsg({ username: 'uzumaru_geoip_bot', textContent: '⏳ Querying all APIs...' }), 9999);
    expect(r).toBe(false);
    expect(store.has(PENDING_KEY(-100))).toBe(true); // pending 还在
  });

  it('结果藏按钮后(无正文+按钮)→ 消费但不答(够不到)', async () => {
    setPending();
    const r = await tryHandleDelegationReceipt(-100, bmsg({ username: 'uzumaru_geoip_bot', textContent: '', inlineKeyboard: [{ text: '确认身份', callbackData: 'x' }] }), 9999);
    expect(r).toBe(true);
    expect(store.has(PENDING_KEY(-100))).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
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
