import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { Bot } from 'grammy';
import type { AllowlistConfig, GroupRecord, PendingRequest } from '../../../src/allowlist/types.js';
import type { BotFlowDeps } from '../../../src/allowlist/bot-flow.js';

vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// notifyMaster 里动态 import 的 addAssistant——不 mock 会穿透到真实 getRedis()
// （2026-08-21 污染事故：fixture 经此写进主人 DM 上下文，bot 把「好群」当真事讲）。
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  addAssistant: vi.fn(async () => undefined),
  getRecent: vi.fn(async () => []),
}));

// notifyMaster 改走 sender 包装器（MarkdownV2 转换）后，给主人的通知不再经过
// deps.bot.api.sendMessage——mock 掉包装器，主人通知断言都查它。
vi.mock('../../../src/bot/sender/telegram.js', () => ({
  sendMessage: vi.fn(async () => 1),
}));

import { sendMessage as senderSendMessage } from '../../../src/bot/sender/telegram.js';
const senderMock = vi.mocked(senderSendMessage);

const MASTER = 6251541967;
const BOT_UID = 999;
const GROUP = -1001234567890;
const APPLICANT = 12345;

// In-memory Redis mock（与 allowlist.test.ts 同款：hash + incr 限流计数）
function createRedisMock() {
  const store = new Map<string, Map<string, string>>();
  const counters = new Map<string, number>();

  function getHash(key: string): Map<string, string> {
    if (!store.has(key)) store.set(key, new Map());
    return store.get(key)!;
  }

  const mock = {
    hget: vi.fn(async (key: string, field: string) => getHash(key).get(field) ?? null),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      getHash(key).set(field, value);
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => {
      const result: Record<string, string> = {};
      for (const [k, v] of getHash(key)) result[k] = v;
      return result;
    }),
    hdel: vi.fn(async (key: string, field: string) => {
      const hash = getHash(key);
      if (hash.has(field)) {
        hash.delete(field);
        return 1;
      }
      return 0;
    }),
    set: vi.fn(async (key: string, _value: string, ...args: unknown[]) => {
      const hasNx = args.some((a) => typeof a === 'string' && a.toUpperCase() === 'NX');
      if (hasNx && counters.has(`__str:${key}`)) return null;
      counters.set(`__str:${key}`, 1);
      return 'OK';
    }),
    del: vi.fn(async (key: string) => {
      counters.delete(`__str:${key}`);
      store.delete(key);
      return 1;
    }),
    incr: vi.fn(async (key: string) => {
      const val = (counters.get(key) ?? 0) + 1;
      counters.set(key, val);
      return val;
    }),
    expire: vi.fn(async () => 1),
    _store: store,
  };

  return mock as unknown as Redis & typeof mock;
}

function defaultConfig(overrides: Partial<AllowlistConfig> = {}): AllowlistConfig {
  return {
    enabled: true,
    redisPrefix: 'xxb:mal:',
    defaultEnabledAfterApproval: false,
    maxSubmissionsPerUserPerDay: 3,
    autoAiReviewOnSubmit: true,
    autoAiReviewMessageLimit: 50,
    aiReviewContextMaxChars: 5000,
    aiApproveAutoEnable: false,
    aiApproveConfidenceThreshold: 0.85,
    ...overrides,
  };
}

type BotApiMock = {
  getChat: ReturnType<typeof vi.fn>;
  getChatMember: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
};

/** 默认：任何 id 都解析成群；bot 在群里；申请人是群主。 */
function makeBot(overrides: Partial<BotApiMock> = {}): { bot: Bot; api: BotApiMock } {
  const api: BotApiMock = {
    getChat: vi.fn(async (id: unknown) => {
      if (id === '@goodgroup' || id === GROUP || id === Number('-1001234567890')) {
        return { id: GROUP, title: '好群', username: 'goodgroup', type: 'supergroup' };
      }
      if (id === '@other' || id === -1009876543210) {
        return { id: -1009876543210, title: '另一个群', username: 'other', type: 'supergroup' };
      }
      throw new Error('chat not found');
    }),
    getChatMember: vi.fn(async (_cid: unknown, uid: unknown) => {
      if (uid === BOT_UID) return { status: 'administrator' };
      return { status: 'creator' };
    }),
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
    ...overrides,
  };
  return { bot: { api } as unknown as Bot, api };
}

function makeDeps(
  api: BotApiMock,
  redis: ReturnType<typeof createRedisMock>,
  aiCall: (s: string, u: string) => Promise<string | null>,
  configOverrides: Partial<AllowlistConfig> = {},
): BotFlowDeps {
  return {
    redis: redis as unknown as Redis,
    bot: { api } as unknown as Bot,
    config: defaultConfig(configOverrides),
    aiCall,
    getRecentContext: async () => '大家都在正常聊天',
    masterUid: MASTER,
    botUid: BOT_UID,
  };
}

// aiCall 分流：审核返回判定 JSON；给主人的通知总结（system 含「通知喉舌」）
// 返回 persona 人话（必须带 chatId，bot-flow 的 sanity 检查才会采用）。
const approveAi = async (sys: string) =>
  sys.includes('通知喉舌')
    ? `喵～「好群」(${GROUP}) 的群主来申请开通啦，群里聊的都很正常，AI 也挺放心（置信 0.95），建议放行。已直接启用喵`
    : '{"decision":"APPROVE","confidence":0.95,"reason":"群内容正常"}';
const rejectAi = async (sys: string) =>
  sys.includes('通知喉舌')
    ? `喵～「好群」(${GROUP}) 这个新群还没聊天记录，AI 没东西可审只能保守拒了。建议你自己瞄一眼再定。\n放行 → 「让群 ${GROUP} 通过」\n拒绝 → 「拒了 ${GROUP}」`
    : '{"decision":"REJECT","confidence":0.9,"reason":"疑似广告群"}';

async function importFlow() {
  return await import('../../../src/allowlist/bot-flow.js');
}

function seedPending(redis: ReturnType<typeof createRedisMock>, patch: Partial<PendingRequest> = {}) {
  const req: PendingRequest = {
    request_id: 'req-1',
    chat_id: GROUP,
    user_id: APPLICANT,
    username: 'applicant',
    first_name: '申请人',
    note: '',
    chat_title: '好群',
    created_at: Math.floor(Date.now() / 1000),
    ai_reason: '',
    review_state: 'needs_manual',
    ...patch,
  };
  return redis.hset('xxb:mal:pending', req.request_id, JSON.stringify(req));
}

describe('allowlist bot-flow', () => {
  let redis: ReturnType<typeof createRedisMock>;
  let flow: Awaited<ReturnType<typeof importFlow>>;

  beforeEach(async () => {
    senderMock.mockClear();
    redis = createRedisMock();
    flow = await importFlow();
  });

  describe('applyViaBot', () => {
    it('群管理申请 + AI 高置信通过 → 直接启用，通知群里和主人', async () => {
      const { api } = makeBot();
      const deps = makeDeps(api, redis, approveAi);
      const outcome = await flow.applyViaBot(deps, {
        applicantUid: APPLICANT,
        applicantUsername: 'applicant',
        target: '@goodgroup',
        note: '群主想玩',
      });
      expect(outcome.kind).toBe('approved');

      const rec = await redis.hget('xxb:mal:groups', String(GROUP));
      expect(rec).toBeTruthy();
      const group = JSON.parse(rec!) as GroupRecord;
      expect(group.approved).toBe(true);
      expect(group.enabled).toBe(true);

      // 群里通知（safeSend 裸发）+ 主人备案（sender 包装器）
      const sentTo = api.sendMessage.mock.calls.map((c) => c[0]);
      expect(sentTo).toContain(GROUP);
      expect(sentTo).not.toContain(MASTER);
      // 给主人的是 LLM persona 总结（通知喉舌），不是结构化模板
      const masterCalls = senderMock.mock.calls.filter((c) => c[0] === MASTER);
      expect(masterCalls).toHaveLength(1);
      expect(String(masterCalls[0]![1])).toContain('已直接启用喵');
    });

    it('给主人的通知：LLM 总结挂掉 → fallback 模板也带操作指引和 chatId', async () => {
      const aiCall = async (sys: string) =>
        sys.includes('通知喉舌')
          ? null // 通知总结失败
          : '{"decision":"REJECT","confidence":0.25,"reason":"群消息摘要为空"}';
      const { api } = makeBot();
      const deps = makeDeps(api, redis, aiCall);
      const outcome = await flow.applyViaBot(deps, {
        applicantUid: APPLICANT,
        target: '@goodgroup',
      });
      expect(outcome.kind).toBe('needs_master');
      const masterMsg = senderMock.mock.calls.find((c) => c[0] === MASTER);
      expect(masterMsg).toBeTruthy();
      expect(String(masterMsg![1])).toContain(`让群 ${GROUP} 通过`);
      expect(String(masterMsg![1])).toContain('群消息摘要为空');
    });

    it('给主人的通知：LLM 总结丢了 chatId → 视为不可用，fallback 模板', async () => {
      const aiCall = async (sys: string) =>
        sys.includes('通知喉舌')
          ? '喵～有个群想开通，看着还行，你说了算' // 没有 chatId
          : '{"decision":"REJECT","confidence":0.9,"reason":"疑似广告群"}';
      const { api } = makeBot();
      const deps = makeDeps(api, redis, aiCall);
      await flow.applyViaBot(deps, { applicantUid: APPLICANT, target: '@goodgroup' });
      const masterMsg = senderMock.mock.calls.find((c) => c[0] === MASTER);
      expect(String(masterMsg![1])).toContain(`让群 ${GROUP} 通过`);
    });

    it('普通成员申请：AI 即使高置信通过也转主人评判（防注入自助开通）', async () => {
      const { api } = makeBot({
        getChatMember: vi.fn(async (_cid: unknown, uid: unknown) => {
          if (uid === BOT_UID) return { status: 'administrator' };
          return { status: 'member' };
        }),
      });
      const deps = makeDeps(api, redis, approveAi);
      const outcome = await flow.applyViaBot(deps, {
        applicantUid: APPLICANT,
        target: '@goodgroup',
      });
      expect(outcome.kind).toBe('needs_master');

      // 未进 groups，pending 保留且 AI 结论已写入
      expect(await redis.hget('xxb:mal:groups', String(GROUP))).toBeNull();
      const pendings = await redis.hgetall('xxb:mal:pending');
      const reqs = Object.values(pendings).map((j) => JSON.parse(j) as PendingRequest);
      expect(reqs).toHaveLength(1);
      expect(reqs[0]!.ai_decision).toBe('APPROVE');
      expect(reqs[0]!.review_state).toBe('needs_manual');
      expect(reqs[0]!.applicant_member_status).toBe('member');
      expect(reqs[0]!.source).toBe('dm');

      // 只通知了主人（sender 包装器），群里没声张
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(senderMock.mock.calls.map((c) => c[0])).toEqual([MASTER]);
    });

    it('AI 拒绝 → 转主人评判，pending 保留', async () => {
      const { api } = makeBot();
      const deps = makeDeps(api, redis, rejectAi);
      const outcome = await flow.applyViaBot(deps, {
        applicantUid: APPLICANT,
        target: '@goodgroup',
      });
      expect(outcome.kind).toBe('needs_master');
      expect(await redis.hget('xxb:mal:groups', String(GROUP))).toBeNull();
      const pendings = await redis.hgetall('xxb:mal:pending');
      expect(Object.keys(pendings)).toHaveLength(1);
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(senderMock.mock.calls.map((c) => c[0])).toEqual([MASTER]);
    });

    it('bot 不在目标群 → not_in_group，不建申请', async () => {
      const { api } = makeBot({
        getChatMember: vi.fn(async (_cid: unknown, uid: unknown) => {
          if (uid === BOT_UID) throw new Error('user not found');
          return { status: 'creator' };
        }),
      });
      const deps = makeDeps(api, redis, approveAi);
      const outcome = await flow.applyViaBot(deps, { applicantUid: APPLICANT, target: '@goodgroup' });
      expect(outcome.kind).toBe('not_in_group');
      expect(Object.keys(await redis.hgetall('xxb:mal:pending'))).toHaveLength(0);
    });

    it('申请人不在目标群 → not_a_member', async () => {
      const { api } = makeBot({
        getChatMember: vi.fn(async (_cid: unknown, uid: unknown) => {
          if (uid === BOT_UID) return { status: 'administrator' };
          return { status: 'left' };
        }),
      });
      const deps = makeDeps(api, redis, approveAi);
      const outcome = await flow.applyViaBot(deps, { applicantUid: APPLICANT, target: '@goodgroup' });
      expect(outcome.kind).toBe('not_a_member');
    });

    it('已在白名单 → already_enabled，不再跑 AI', async () => {
      await redis.hset(
        'xxb:mal:groups',
        String(GROUP),
        JSON.stringify({ chat_id: GROUP, approved: true, enabled: true }),
      );
      const aiCall = vi.fn(approveAi);
      const { api } = makeBot();
      const deps = makeDeps(api, redis, aiCall);
      const outcome = await flow.applyViaBot(deps, { applicantUid: APPLICANT, target: '@goodgroup' });
      expect(outcome.kind).toBe('already_enabled');
      expect(aiCall).not.toHaveBeenCalled();
    });

    it('批过但没启用的群：申请即顺手启用', async () => {
      await redis.hset(
        'xxb:mal:groups',
        String(GROUP),
        JSON.stringify({ chat_id: GROUP, approved: true, enabled: false }),
      );
      const { api } = makeBot();
      const deps = makeDeps(api, redis, approveAi);
      const outcome = await flow.applyViaBot(deps, { applicantUid: APPLICANT, target: '@goodgroup' });
      expect(outcome.kind).toBe('already_enabled');
      const rec = JSON.parse((await redis.hget('xxb:mal:groups', String(GROUP)))!) as GroupRecord;
      expect(rec.enabled).toBe(true);
    });

    it('已有 pending → already_pending', async () => {
      await seedPending(redis);
      const { api } = makeBot();
      const deps = makeDeps(api, redis, approveAi);
      const outcome = await flow.applyViaBot(deps, { applicantUid: APPLICANT, target: '@goodgroup' });
      expect(outcome.kind).toBe('already_pending');
    });

    it('超每日限流 → rate_limited', async () => {
      const { api } = makeBot();
      const deps = makeDeps(api, redis, approveAi, { maxSubmissionsPerUserPerDay: 1 });
      const first = await flow.applyViaBot(deps, { applicantUid: APPLICANT, target: '@goodgroup' });
      expect(first.kind).toBe('approved');
      const second = await flow.applyViaBot(deps, { applicantUid: APPLICANT, target: '@other' });
      expect(second.kind).toBe('rate_limited');
    });

    it('去掉 -100 前缀的短群 id 也能解析', async () => {
      const { api } = makeBot();
      const deps = makeDeps(api, redis, approveAi);
      const outcome = await flow.applyViaBot(deps, {
        applicantUid: APPLICANT,
        target: '1234567890',
      });
      expect(outcome.kind).toBe('approved');
      expect(api.getChat).toHaveBeenCalledWith(Number('-1001234567890'));
    });

    it('解析不到的目标 → not_found', async () => {
      const { api } = makeBot();
      const deps = makeDeps(api, redis, approveAi);
      const outcome = await flow.applyViaBot(deps, {
        applicantUid: APPLICANT,
        target: '@nosuchgroup',
      });
      expect(outcome.kind).toBe('not_found');
    });
  });

  describe('reviewOnJoin', () => {
    it('入群自动审核：管理拉群 + AI 通过 → 启用并宣布', async () => {
      const { api } = makeBot();
      const deps = makeDeps(api, redis, approveAi);
      await flow.reviewOnJoin(deps, GROUP, { uid: APPLICANT, username: 'applicant' });

      const rec = await redis.hget('xxb:mal:groups', String(GROUP));
      expect(rec).toBeTruthy();
      expect(JSON.parse(rec!).enabled).toBe(true);
      const sentTo = api.sendMessage.mock.calls.map((c) => c[0]);
      expect(sentTo).toContain(GROUP);
      expect(sentTo).not.toContain(MASTER);
      expect(senderMock.mock.calls.map((c) => c[0])).toEqual([MASTER]);
      // pending 来源标注为 join
      // （approved 后 pending 已删，从 groups 记录侧面验证链路走通即可）
    });

    it('普通成员拉群：AI 通过也不自动启用，转主人', async () => {
      const { api } = makeBot({
        getChatMember: vi.fn(async (_cid: unknown, uid: unknown) => {
          if (uid === BOT_UID) return { status: 'member' };
          return { status: 'member' };
        }),
      });
      const deps = makeDeps(api, redis, approveAi);
      await flow.reviewOnJoin(deps, GROUP, { uid: APPLICANT });
      expect(await redis.hget('xxb:mal:groups', String(GROUP))).toBeNull();
      // 群里静默，只通知主人
      expect(api.sendMessage).not.toHaveBeenCalled();
      expect(senderMock.mock.calls.map((c) => c[0])).toEqual([MASTER]);
    });

    it('已在白名单 → 只发已就绪，不跑 AI', async () => {
      await redis.hset(
        'xxb:mal:groups',
        String(GROUP),
        JSON.stringify({ chat_id: GROUP, approved: true, enabled: true }),
      );
      const aiCall = vi.fn(approveAi);
      const { api } = makeBot();
      const deps = makeDeps(api, redis, aiCall);
      await flow.reviewOnJoin(deps, GROUP, { uid: APPLICANT });
      expect(aiCall).not.toHaveBeenCalled();
      expect(api.sendMessage.mock.calls.map((c) => c[0])).toEqual([GROUP]);
    });
  });

  describe('masterApprove / masterReject / listForMaster', () => {
    it('masterApprove：pending → 启用，通知群和申请人', async () => {
      await seedPending(redis);
      const { api } = makeBot();
      const deps = makeDeps(api, redis, rejectAi);
      const outcome = await flow.masterApprove(deps, String(GROUP));
      expect(outcome.kind).toBe('approved');

      const rec = JSON.parse((await redis.hget('xxb:mal:groups', String(GROUP)))!) as GroupRecord;
      expect(rec.enabled).toBe(true);
      expect(rec.approved_by).toBe('master');
      expect(await redis.hget('xxb:mal:pending', 'req-1')).toBeNull();

      const sentTo = api.sendMessage.mock.calls.map((c) => c[0]);
      expect(sentTo).toContain(GROUP);
      expect(sentTo).toContain(APPLICANT);
    });

    it('masterApprove 幂等：已启用群无 pending 也回报 approved', async () => {
      await redis.hset(
        'xxb:mal:groups',
        String(GROUP),
        JSON.stringify({ chat_id: GROUP, approved: true, enabled: true }),
      );
      const { api } = makeBot();
      const deps = makeDeps(api, redis, rejectAi);
      const outcome = await flow.masterApprove(deps, '@goodgroup');
      expect(outcome.kind).toBe('approved');
    });

    it('masterApprove 找不到目标 → not_pending', async () => {
      const { api } = makeBot();
      const deps = makeDeps(api, redis, rejectAi);
      const outcome = await flow.masterApprove(deps, '@nosuchgroup');
      expect(outcome.kind).toBe('not_pending');
    });

    it('masterReject：pending 移 reviewed，DM 通知申请人', async () => {
      await seedPending(redis);
      const { api } = makeBot();
      const deps = makeDeps(api, redis, rejectAi);
      const outcome = await flow.masterReject(deps, String(GROUP), '广告群不收');
      expect(outcome.kind).toBe('rejected');
      expect(await redis.hget('xxb:mal:pending', 'req-1')).toBeNull();
      expect(await redis.hget('xxb:mal:reviewed', 'req-1')).toBeTruthy();
      const dm = api.sendMessage.mock.calls.find((c) => c[0] === APPLICANT);
      expect(dm).toBeTruthy();
      expect(String(dm![1])).toContain('广告群不收');
    });

    it('listForMaster：聚合待评判/已通过/已拒绝', async () => {
      await seedPending(redis, {
        ai_decision: 'REJECT',
        ai_confidence: 0.9,
        ai_reason: '疑似广告',
        ai_reviewed_at: Math.floor(Date.now() / 1000),
      });
      await redis.hset(
        'xxb:mal:groups',
        '-100111',
        JSON.stringify({
          chat_id: -100111,
          approved: true,
          enabled: true,
          approved_by: 'ai',
          approved_at: 1000,
          title: '老群',
          review_state: 'auto_approved',
          ai_reason: '正常',
        }),
      );
      await redis.hset(
        'xxb:mal:reviewed',
        'req-old',
        JSON.stringify({
          request_id: 'req-old',
          chat_id: -100222,
          user_id: 1,
          note: '',
          chat_title: '被拒群',
          created_at: 1000,
          ai_reason: '涉赌',
          review_state: 'needs_manual',
        }),
      );
      const { api } = makeBot();
      const deps = makeDeps(api, redis, rejectAi);
      const out = await flow.listForMaster(deps);
      expect(out).toContain('待评判 (1)');
      expect(out).toContain('已通过 (1)');
      expect(out).toContain('已拒绝 (1');
      expect(out).toContain('疑似广告');
      expect(out).toContain('req-1');
    });
  });
});
