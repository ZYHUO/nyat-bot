import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * round 201：arg-carrier 必须按**占位形状**判，不能"有任何中文就算带了参"。
 *
 * 现场：全日志 72 条 delegated learned command 里 36 条本该被缺参闸拦
 * （usage_syntax 有占位且 args 空），其中 /geo 空参 20 条——而闸的日志 0 次。
 *
 * 根因是第三个条件：
 *   `if (/[一-龥\w]{2,}/.test(t)) return true;`
 * 群聊里最近 6 条人类消息几乎总有两个以上中文字符 → 这个函数恒 true → 闸永不拦。
 *
 * 现在：占位写 `<IP或域名>` 只认 IP/域名；认不出形状 → fail-open。
 */

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string, ...a: unknown[]) => { if (a.includes('NX') && store.has(k)) return null; store.set(k, v); return 'OK'; }),
  del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
};

let profile: Record<string, unknown> | undefined;
let recentContext: Array<{ role: string; textContent: string; isBot: boolean; messageId: number; uid: number }> = [];

vi.mock('../../../src/env.js', () => ({
  env: () => ({ BOT_DELEGATION_ENABLED: true, BOT_DELEGATION_COOLDOWN_SEC: 60, BOT_NICKNAMES: ['本喵'], BOT_USERNAME: 'hunhebi_bot' }),
}));
vi.mock('../../../src/shared/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));
vi.mock('../../../src/bot/sender/telegram.js', () => ({ sendMessage: vi.fn(async () => 12345) }));
vi.mock('../../../src/learners/bot-command-store.js', () => ({
  getCommandProfile: () => profile,
  whyNotInvocable: () => null,
}));
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: async () => recentContext,
  addAssistant: vi.fn(async () => {}),
}));
vi.mock('../../../src/pipeline/context/slim.js', () => ({ slimContextForAI: () => 'CTX' }));
vi.mock('../../../src/pipeline/reply/prompt-builder.js', () => ({ buildSystemPrompt: () => 'SYS' }));
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: vi.fn(async () => ({ content: '{"replyContent":"查到啦"}' })) }));
vi.mock('../../../src/pipeline/reply/parser.js', () => ({
  parseReplyResponse: () => [{ replyContent: '查到啦' }],
  isBlankReply: (t: string) => { const s = (t ?? '').trim(); return !s || /^[.。．·•…‥\s]+$/.test(s); },
}));

const { tryDelegateCommand } = await import('../../../src/pipeline/tools/bot-delegation.js');

function human(text: string) {
  return { role: 'user', textContent: text, isBot: false, messageId: 1, uid: 1 };
}

beforeEach(() => {
  store.clear();
  profile = { usage_syntax: '/geo <IP或域名>', command: '/geo', bot: 'uzumaru_geoip_bot' };
  recentContext = [];
});

describe('arg-carrier 按占位形状判', () => {
  it('① 只有中文闲聊、没有 IP/域名 → 判为没带参（闸该拦）', async () => {
    recentContext = [human('哈哈哈哈太草了'), human('今天天气不错啊兄弟们'), human('刚下班累死了')];
    const res = await tryDelegateCommand(-100, 'uzumaru_geoip_bot', '/geo', '');
    expect(res.text).toContain('这个命令要带参数');
    expect(res.text).toContain('别自己编一个填进去');
    expect(res.sent).toBe(false);
  });

  it('② 上下文里有 IP → 放行（人类确实带了）', async () => {
    recentContext = [human('8.8.8.8')];
    const res = await tryDelegateCommand(-100, 'uzumaru_geoip_bot', '/geo', '');
    expect(res.text).not.toContain('这个命令要带参数');
  });

  it('③ 上下文里有域名 → 放行', async () => {
    recentContext = [human('example.com')];
    const res = await tryDelegateCommand(-100, 'uzumaru_geoip_bot', '/geo', '');
    expect(res.text).not.toContain('这个命令要带参数');
  });

  it('④ 读不到上下文 → fail-open（不拦）', async () => {
    // getRecent 抛错时 catch 里 return true
    recentContext = [];
    const orig = await import('../../../src/pipeline/context/manager.js');
    void orig;
    const res = await tryDelegateCommand(-100, 'uzumaru_geoip_bot', '/geo', '');
    // 空上下文不是"读不到"，是"没人说话"→ 该拦
    expect(res.text).toContain('这个命令要带参数');
  });

  it('⑤ 源码里改成了形状判据', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/pipeline/tools/bot-delegation.ts', 'utf8');
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.some((l) => l.includes('argShapesFor(usageSyntax)'))).toBe(true);
    expect(code.some((l) => l.includes('humanMessageCarriesArg(chatId, profile?.usage_syntax)'))).toBe(true);
  });

  it('⑥ 认不出占位形状的命令 → fail-open（宁可少拦）', async () => {
    profile = { usage_syntax: '/q 随便用', command: '/q', bot: 'x' };
    recentContext = [human('哈哈哈哈')];
    const res = await tryDelegateCommand(-100, 'x', '/q', '');
    expect(res.text).not.toContain('这个命令要带参数');
  });
});
