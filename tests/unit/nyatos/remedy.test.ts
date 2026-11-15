/**
 * 反广告 · 可用手段（remedy）+ 入群筛查的 Frame 接线回归。
 *
 * 这个文件存在的理由是一件真事：入群筛查第一版把 extractJoinerName 从
 * './join-signals.js' 取，而它其实住在 './ad-pressure.js'。运行时会拿到
 * undefined、一调用就抛，被 frame 里那个"非关键路径"的 catch 吞掉——
 * **入群筛查从此静默失效，而 typecheck 一直是红的**（vitest 不做类型检查，
 * 所以 3227 个测试全绿）。宿主"写了没人调"这个毛病，换了个更隐蔽的形式。
 *
 * 所以这里锁两条：
 *   1. nmbot 的"通过验证"消息必须真的在 Frame 里长出 [入群] 行
 *   2. 群主授过权才出现 [授权] 行，且行里两张牌都在；没授权整行不出现
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hash = new Map<string, string>();

const redisMock = {
  get: vi.fn(async (k: string) => hash.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { hash.set(k, v); return 'OK'; }),
  del: vi.fn(async (k: string) => (hash.delete(k) ? 1 : 0)),
  expire: vi.fn(async () => 1),
  incr: vi.fn(async () => 1),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envValues: Record<string, unknown> = {
  COGNITIVE_EVENTS_ENABLED: true,
  SELF_HISTORY_ENABLED: true,
  NYATOS_SHADOW_TIMEOUT_MS: 20_000,
  ANTIAD_KICK_ENABLED: false,
};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

// 入群筛查要真去查头像；给一个可调的总数。
const profilePhotos = { total_count: 0 };
vi.mock('../../../src/bot/bot.js', () => ({
  getBot: () => ({
    api: {
      getUserProfilePhotos: async () => profilePhotos,
    },
  }),
  getBotUid: () => 999,
  getBotUsername: () => 'hunhebi_bot',
}));

const collectConversationField = vi.fn();
vi.mock('../../../src/agent/conversation-field.js', () => ({
  collectConversationField: (...a: unknown[]) => collectConversationField(...a),
}));

const m = await import('../../../src/nyatos/frame.js');
const adp = await import('../../../src/nyatos/ad-pressure.js');
const remedy = await import('../../../src/nyatos/remedy.js');

beforeEach(() => {
  hash.clear();
  profilePhotos.total_count = 0;
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0038_bot_command_profiles.sql', 'utf8'));
  collectConversationField.mockReset();
});

const CHAT = -1003184176508;
const JOINER = 8901282297;

function msg(over: Record<string, unknown> = {}) {
  return {
    role: 'user' as const,
    uid: 1001,
    username: 'awei',
    fullName: '阿伟',
    timestamp: Math.floor(Date.now() / 1000) - 60,
    messageId: 1,
    textContent: '在吗',
    isForwarded: false,
    ...over,
  };
}

const build = async (recent: Array<Record<string, unknown>>) =>
  m.buildFrame({
    scope: { visibility: 'chat', chatId: CHAT },
    trigger: msg({ messageId: 9 }) as never,
    recent: recent as never[],
    botUid: 999,
  });

describe('入群筛查 · Frame 接线（回归：写好了却没接上）', () => {
  it('nmbot 的"通过验证"消息长出 [入群] 行', async () => {
    const frame = await build([
      msg({
        messageId: 265225,
        uid: 5304501737,
        username: 'nmnmfunbot',
        textContent: 'Jeffrey Thompson has passed the group verification.',
      }),
    ]);
    expect(frame.self.joinScreen).toBeTruthy();
    expect(frame.self.joinScreen).toContain('Jeffrey Thompson');
    expect(m.renderFrame(frame)).toContain('[入群]');
  });

  it('三个账号事实都在行里（没头像 / 名字形态 / 首次见到）', async () => {
    const frame = await build([
      msg({
        messageId: 265225,
        uid: 5304501737,
        username: 'nmnmfunbot',
        textContent: 'xK9mQ2pLwR7v has passed the group verification.',
      }),
    ]);
    const line = frame.self.joinScreen ?? '';
    expect(line).toContain('没有头像');
    expect(line).toContain('纯字母数字无空格');
    expect(line).toContain('第一次见到');
  });

  it('非 nmbot 的入群类消息不触发（名字从 nmbot 消息里取，不从别人嘴里取）', async () => {
    const frame = await build([
      msg({
        messageId: 5,
        uid: 4242,
        username: 'someone',
        textContent: 'Tiara Agar ⭐️ 被管理员 Ranko Kanzaki ⭐️ 封禁并向 nmBot 举报。',
      }),
    ]);
    expect(frame.self.joinScreen).toBeUndefined();
  });
});

describe('反广告 · 可用手段（remedy）', () => {
  it('没授权 → 整行不出现，且列不出命令', async () => {
    const r = await remedy.readRemedies(CHAT);
    expect(r.granted).toBe(false);
    expect(remedy.renderRemedies(r)).toBe('');
  });

  it('授权后两张牌都在行里', async () => {
    await adp.setAntiAd(CHAT, true);
    const r = await remedy.readRemedies(CHAT);
    expect(r.granted).toBe(true);
    const line = remedy.renderRemedies(r);
    expect(line).toContain('[授权]');
    expect(line).toContain('admin.kick');
  });

  it('命令档案里的回复式命令会出现在行里（不是宿主硬编码的清单）', async () => {
    await adp.setAntiAd(CHAT, true);
    db.prepare(
      `INSERT INTO bot_command_profiles
       (bot_username, command_name, usage_syntax, use_scenario, needs_reply, needs_admin,
        output_type, confidence, observation_count, status)
       VALUES ('nmnmfunbot', '/spam', '/spam', '举报群内违规用户并触发封禁', 1, 0, 'text', 0.95, 18, 'ready')`,
    ).run();
    const r = await remedy.readRemedies(CHAT);
    const line = remedy.renderRemedies(r);
    expect(line).toContain('/spam@nmnmfunbot');
  });

  it('私聊里不报（chatId > 0）', async () => {
    const r = await remedy.readRemedies(7044055491);
    expect(r.granted).toBe(false);
    expect(remedy.renderRemedies(r)).toBe('');
  });

  it('授权群的 Frame 里出现 [授权] 行', async () => {
    await adp.setAntiAd(CHAT, true);
    const frame = await build([msg()]);
    expect(m.renderFrame(frame)).toContain('[授权]');
  });
});
