/**
 * 回复式代发（bots.command 带 replyToMessageId）—— 让别的 bot 代罚。
 *
 * 背景：nmbot 的入群验证消息带 5 个按钮（通过 / 拒绝 / 拒绝并举报骚扰 …），
 * 封禁回执带 2 个（解除封禁 / 举报骚扰）。**这些按钮 bot 点不了**——Telegram
 * 的 callback_query 只能由真人点击产生，没有 API 能合成一次点击。但 nmbot 同时
 * 认命令，`/spam` 是 needs_reply=1 且学熟；回复那条广告发出去，效果就等于有人
 * 按了「拒绝并举报骚扰」。这就是 bot 唯一够得到的代罚通道。
 *
 * 锁的 invariants：
 *   - 群主没授权反广告 → 一条都发不出去（与 admin.kick 同一把钥匙）
 *   - 只有"必须回复才生效"且学熟、不需 admin 的命令能走这条路
 *   - replyToMessageId 必须是最近真见过的消息（防臆想 id）
 *   - 限速：每小时上限 + 最小间隔
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
  incr: vi.fn(async (k: string) => {
    const n = Number(hash.get(k) ?? 0) + 1;
    hash.set(k, String(n));
    return n;
  }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

let db: Database.Database;
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const envValues: Record<string, unknown> = {
  BOT_REPLY_DELEGATION_ENABLED: true,
  BOT_REPLY_DELEGATION_COOLDOWN_SEC: 60,
  BOT_REPLY_DELEGATION_MAX_PER_HOUR: 3,
  ANTIAD_KICK_ENABLED: false,
  BOT_DELEGATION_ENABLED: true,
  BOT_DELEGATION_COOLDOWN_SEC: 60,
};
vi.mock('../../../src/env.js', () => ({ env: () => envValues }));

const sent: Array<{ chatId: number; text: string; replyTo?: number }> = [];
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: vi.fn(async (chatId: number, text: string, replyTo?: number) => {
    sent.push({ chatId, text, replyTo });
    return 700001;
  }),
}));
vi.mock('../../../src/bot/bot.js', () => ({
  getBotUsername: () => 'hunhebi_bot',
  getBotUid: () => 999,
}));

const recent: Array<Record<string, unknown>> = [];
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getRecent: vi.fn(async () => recent),
  addAssistant: vi.fn(async () => undefined),
}));

const m = await import('../../../src/pipeline/tools/bot-delegation.js');
const store = await import('../../../src/learners/bot-command-store.js');

beforeEach(() => {
  hash.clear();
  sent.length = 0;
  recent.length = 0;
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0038_bot_command_profiles.sql', 'utf8'));
});

const CHAT = -1003184176508;
const AD_MID = 265999;

/** 学熟到能回复式代发的 /spam（nmnmfunbot）。 */
const seedSpam = (): void => {
  db.prepare(
    `INSERT INTO bot_command_profiles
     (bot_username, command_name, usage_syntax, use_scenario, needs_reply, needs_admin,
      output_type, confidence, observation_count, status)
     VALUES ('nmnmfunbot', '/spam', '/spam', '举报群内违规用户并触发封禁', 1, 0, 'text', 0.95, 18, 'ready')`,
  ).run();
};

const grant = (): void => { hash.set(`xxb:trench:antiad:${CHAT}`, '1'); };

const withAd = (): void => {
  recent.push({ messageId: AD_MID, uid: 555000111, textContent: '低价出水果机 看主页' });
};

describe('回复式代发 · 闸口', () => {
  it('总闸关着 → 不发', async () => {
    envValues.BOT_REPLY_DELEGATION_ENABLED = false;
    seedSpam(); grant(); withAd();
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', AD_MID);
    expect(r.sent).toBe(false);
    expect(sent).toHaveLength(0);
    envValues.BOT_REPLY_DELEGATION_ENABLED = true;
  });

  it('私聊 → 不发', async () => {
    seedSpam();
    const r = await m.tryDelegateReplyCommand(7044055491, 'nmnmfunbot', '/spam', '', AD_MID);
    expect(r.sent).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('**群主没授权反广告 → 一条都发不出去**（与 admin.kick 同一把钥匙）', async () => {
    seedSpam(); withAd();
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', AD_MID);
    expect(r.sent).toBe(false);
    expect(r.text).toContain('没授权反广告');
    expect(sent).toHaveLength(0);
  });

  it('ANTIAD_KICK_ENABLED 单独开也能走（不必先开反广告）', async () => {
    envValues.ANTIAD_KICK_ENABLED = true;
    seedSpam(); withAd();
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', AD_MID);
    expect(r.sent).toBe(true);
    envValues.ANTIAD_KICK_ENABLED = false;
  });

  it('replyToMessageId 缺失/非法 → 不发', async () => {
    seedSpam(); grant(); withAd();
    expect((await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', 0)).sent).toBe(false);
    expect((await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', -5)).sent).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('回复目标不在最近 60 条里 → 不发（防臆想 messageId）', async () => {
    seedSpam(); grant();
    recent.push({ messageId: 111, uid: 1, textContent: '别的消息' });
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', AD_MID);
    expect(r.sent).toBe(false);
    expect(r.text).toContain('没有 messageId');
    expect(sent).toHaveLength(0);
  });
});

describe('回复式代发 · 命令档案即授权', () => {
  beforeEach(() => { seedSpam(); grant(); withAd(); });

  it('没学过 → 不发，并把合法清单回给模型', async () => {
    db.prepare('DELETE FROM bot_command_profiles').run();
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', AD_MID);
    expect(r.sent).toBe(false);
    expect(r.text).toContain('可回复式代发的只有');
  });

  it('blocked 命令（/ban）→ 硬禁', async () => {
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/ban', '123', AD_MID);
    expect(r.sent).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('needs_admin=1 → 不发', async () => {
    db.prepare('DELETE FROM bot_command_profiles').run();
    db.prepare(
      `INSERT INTO bot_command_profiles
       (bot_username, command_name, usage_syntax, use_scenario, needs_reply, needs_admin,
        output_type, confidence, observation_count, status)
       VALUES ('nmnmfunbot', '/unban', '/unban', '解封', 1, 1, 'text', 0.9, 9, 'ready')`,
    ).run();
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/unban', '', AD_MID);
    expect(r.sent).toBe(false);
    expect(r.text).toContain('管理员权限');
  });

  it('不需要回复的命令（/cards）→ 指回去走普通代发', async () => {
    db.prepare(
      `INSERT INTO bot_command_profiles
       (bot_username, command_name, usage_syntax, use_scenario, needs_reply, needs_admin,
        output_type, confidence, observation_count, status)
       VALUES ('nmnmfunbot', '/cards', '/cards', '查询入群验证状态', 0, 0, 'text', 0.95, 9, 'ready')`,
    ).run();
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/cards', '', AD_MID);
    expect(r.sent).toBe(false);
    expect(r.text).toContain('普通代发');
  });

  it('没学熟（观察次数不够）→ 不发', async () => {
    db.prepare('DELETE FROM bot_command_profiles').run();
    db.prepare(
      `INSERT INTO bot_command_profiles
       (bot_username, command_name, usage_syntax, use_scenario, needs_reply, needs_admin,
        output_type, confidence, observation_count, status)
       VALUES ('nmnmfunbot', '/spam', '/spam', '举报', 1, 0, 'text', 0.4, 1, 'learning')`,
    ).run();
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', AD_MID);
    expect(r.sent).toBe(false);
    expect(r.text).toContain('观察够次数');
  });

  it('回执藏在按钮后（output_type=callback）→ 不发', async () => {
    db.prepare('DELETE FROM bot_command_profiles').run();
    db.prepare(
      `INSERT INTO bot_command_profiles
       (bot_username, command_name, usage_syntax, use_scenario, needs_reply, needs_admin,
        output_type, confidence, observation_count, status)
       VALUES ('nmnmfunbot', '/spam', '/spam', '举报', 1, 0, 'callback', 0.95, 18, 'ready')`,
    ).run();
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', AD_MID);
    expect(r.sent).toBe(false);
    expect(r.text).toContain('按钮后面');
  });
});

describe('回复式代发 · 发送与限速', () => {
  beforeEach(() => { seedSpam(); grant(); withAd(); });

  it('成功：挂在真实消息上发出 /spam@nmnmfunbot', async () => {
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', AD_MID);
    expect(r.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('/spam@nmnmfunbot');
    expect(sent[0]!.replyTo).toBe(AD_MID);
    // 让模型别急着跟群友宣布结果
    expect(r.text).toContain('别急着');
  });

  it('冷却期内第二次 → 不发', async () => {
    expect((await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', AD_MID)).sent).toBe(true);
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', AD_MID);
    expect(r.sent).toBe(false);
    expect(r.text).toContain('缓一下');
    expect(sent).toHaveLength(1);
  });

  it('每小时上限 3 次，超过就只观察不动手', async () => {
    // 直接把这小时的计数顶到上限（冷却是另一道闸，单独测）——这里只测上限本身。
    hash.set(`xxb:delegation:reply:n:${CHAT}`, '3');
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', AD_MID);
    expect(r.sent).toBe(false);
    expect(r.text).toContain('上限');
    expect(sent).toHaveLength(0);
  });

  it('计数是每群独立的（一个群打满不连坐别的群）', async () => {
    const other = -1002767093213;
    hash.set(`xxb:delegation:reply:n:${CHAT}`, '3');
    recent.push({ messageId: 888, uid: 1, textContent: '别的群的广告' });
    hash.set(`xxb:trench:antiad:${other}`, '1');
    const r = await m.tryDelegateReplyCommand(other, 'nmnmfunbot', '/spam', '', 888);
    expect(r.sent).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('发失败（sendMessage 返 0）→ 报 sent:false，不登记冷却', async () => {
    const { sendMessage } = await import('../../../src/bot/sender/telegram.js');
    vi.mocked(sendMessage).mockResolvedValueOnce(0);
    const r = await m.tryDelegateReplyCommand(CHAT, 'nmnmfunbot', '/spam', '', AD_MID);
    expect(r.sent).toBe(false);
  });
});

describe('可回复命令清单（listReplyInvocableCommands）', () => {
  it('只列 needs_reply=1 且过闸的，且每条都真的能过闸', async () => {
    seedSpam();
    db.prepare(
      `INSERT INTO bot_command_profiles
       (bot_username, command_name, usage_syntax, use_scenario, needs_reply, needs_admin,
        output_type, confidence, observation_count, status)
       VALUES ('kmuav2bot', '/pickbottle', '/pickbottle', '捡瓶子', 1, 0, 'text', 0.8, 4, 'ready')`,
    ).run();
    // 这条 needs_admin=1，必须被挡在清单外
    db.prepare(
      `INSERT INTO bot_command_profiles
       (bot_username, command_name, usage_syntax, use_scenario, needs_reply, needs_admin,
        output_type, confidence, observation_count, status)
       VALUES ('nmnmfunbot', '/unban', '/unban', '解封', 1, 1, 'text', 0.9, 9, 'ready')`,
    ).run();
    const list = store.listReplyInvocableCommands();
    const keys = list.map((c) => `${c.command}@${c.bot}`);
    expect(keys).toContain('/spam@nmnmfunbot');
    expect(keys).toContain('/pickbottle@kmuav2bot');
    expect(keys).not.toContain('/unban@nmnmfunbot');
    // 清单里每一条都必须真的过得去闸（否则等于给模型一张假菜单）
    for (const c of list) {
      const profile = store.getCommandProfile(c.bot, c.command);
      expect(store.whyNotReplyInvocable(profile)).toBeNull();
    }
  });
});
