/**
 * `isGroupAdmin` —— 群主自助授权的安全校验。
 *
 * 2026-09-21 发现这个模块**零测试 import**，而它是 `admin.setAntiAd` /
 * `admin.kick` 的唯一守门人：群主在群里直接说"开反广告"就能开，不需要先去找
 * bot 主人。**没有这道校验，任何一个群成员都能打开一个会删消息/踢人的开关。**
 *
 * 这里锁四件事：
 *   ① administrator / creator → true
 *   ② member / restricted / left / kicked → false
 *   ③ Telegram 读失败 → false（fail-closed：宁可拒绝，不误授权）
 *   ④ 非整数/越界 userId 不炸（getChatMember 的参数是它自己规范化的）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getChatMember: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../src/shared/logger.js', () => ({ logger: mocks.logger }));

const { isGroupAdmin, getBotPermissions } = await import('../../../src/admin/bot-permission.js');
import type { Bot } from 'grammy';

const bot = { api: { getChatMember: mocks.getChatMember } } as unknown as Bot;
const CHAT = -100;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isGroupAdmin', () => {
  it('① creator → true', async () => {
    mocks.getChatMember.mockResolvedValue({ status: 'creator' });
    expect(await isGroupAdmin(bot, CHAT, 111)).toBe(true);
  });

  it('①b administrator → true', async () => {
    mocks.getChatMember.mockResolvedValue({ status: 'administrator' });
    expect(await isGroupAdmin(bot, CHAT, 111)).toBe(true);
  });

  it('② member / restricted / left / kicked → false', async () => {
    for (const s of ['member', 'restricted', 'left', 'kicked', '']) {
      mocks.getChatMember.mockResolvedValue({ status: s });
      expect(await isGroupAdmin(bot, CHAT, 111), s).toBe(false);
    }
  });

  it('②b status 缺失（响应形状意外）→ false，不抛', async () => {
    mocks.getChatMember.mockResolvedValue({});
    expect(await isGroupAdmin(bot, CHAT, 111)).toBe(false);
  });

  it('③ Telegram 读失败 → false（fail-closed，不误授权）', async () => {
    mocks.getChatMember.mockRejectedValue(new Error('chat not found'));
    expect(await isGroupAdmin(bot, CHAT, 111)).toBe(false);
    expect(mocks.logger.debug).toHaveBeenCalled();
  });

  it('③b 网络层 TypeError 同样 fail-closed', async () => {
    mocks.getChatMember.mockRejectedValue(new TypeError('fetch failed'));
    expect(await isGroupAdmin(bot, CHAT, 111)).toBe(false);
  });

  it('④ userId 被 floor 规范化后传给 Telegram', async () => {
    mocks.getChatMember.mockResolvedValue({ status: 'member' });
    await isGroupAdmin(bot, CHAT, 111.9);
    expect(mocks.getChatMember).toHaveBeenCalledWith(CHAT, 111);
  });

  it('④b 匿名发送者（userId=0）也能查，不会抛', async () => {
    mocks.getChatMember.mockResolvedValue({ status: 'member' });
    expect(await isGroupAdmin(bot, CHAT, 0)).toBe(false);
    expect(mocks.getChatMember).toHaveBeenCalledWith(CHAT, 0);
  });

  it('⑤ 大小写不敏感以外的状态串（如 "Administrator"）→ false（Telegram 只发小写，别猜）', async () => {
    mocks.getChatMember.mockResolvedValue({ status: 'Administrator' });
    expect(await isGroupAdmin(bot, CHAT, 111)).toBe(false);
  });
});

describe('getBotPermissions', () => {
  // 快照形状以 src/admin/bot-permission.ts 的 BotPermissionSnapshot 为准：
  // status / can_send_* / can_delete_messages / can_pin_messages / …
  // 第一版我按臆测的 `isAdmin` / `canDeleteMessages` 写，三个全红——
  // 失败的正是它们，才没让一份覆盖面错误的测试混过去。
  const botWith = (member: Record<string, unknown>) =>
    ({
      api: {
        getMe: vi.fn().mockResolvedValue({ id: 999 }),
        getChatMember: vi.fn().mockResolvedValue(member),
        getChat: vi.fn().mockResolvedValue({ id: CHAT, type: 'supergroup' }),
      },
    } as unknown as Bot);

  it('⑥ bot 是管理员 → 快照带 can_* 位', async () => {
    const snap = await getBotPermissions(botWith({
      status: 'administrator',
      can_delete_messages: true, can_restrict_members: false, can_pin_messages: true,
    }), CHAT);
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe('administrator');
    expect(snap!.can_delete_messages).toBe(true);
    expect(snap!.can_restrict_members).toBe(false);
    expect(snap!.can_pin_messages).toBe(true);
    // 非 restricted 的成员默认能发言
    expect(snap!.can_send_messages).toBe(true);
  });

  it('⑥b creator → 全部管理位无条件 true（群主不需要被授）', async () => {
    const snap = await getBotPermissions(botWith({ status: 'creator' }), CHAT);
    expect(snap!.can_delete_messages).toBe(true);
    expect(snap!.can_restrict_members).toBe(true);
    expect(snap!.can_pin_messages).toBe(true);
    expect(snap!.can_manage_chat).toBe(true);
  });

  it('⑥c bot 是普通成员 → 管理位全 false（不误判成有权限）', async () => {
    const snap = await getBotPermissions(botWith({ status: 'member' }), CHAT);
    expect(snap!.status).toBe('member');
    expect(snap!.can_delete_messages).toBe(false);
    expect(snap!.can_restrict_members).toBe(false);
    expect(snap!.can_pin_messages).toBe(false);
    expect(snap!.can_send_messages).toBe(true);
  });

  it('⑥d 被踢/已退 → 不能发言', async () => {
    for (const s of ['left', 'kicked']) {
      const snap = await getBotPermissions(botWith({ status: s }), CHAT);
      expect(snap!.can_send_messages, s).toBe(false);
    }
  });

  it('⑥e restricted → 各项按 Telegram 给的 can_* 走', async () => {
    const snap = await getBotPermissions(botWith({
      status: 'restricted',
      can_send_messages: true,
      // 媒体是"任一没说禁就能发"——要让它 false 得把五项全禁掉
      can_send_photos: false, can_send_videos: false, can_send_documents: false,
      can_send_audios: false, can_send_other_messages: false,
      can_send_polls: false, can_send_voice_notes: false,
    }), CHAT);
    expect(snap!.can_send_messages).toBe(true);
    expect(snap!.can_send_media).toBe(false);
    expect(snap!.can_send_polls).toBe(false);
    expect(snap!.can_send_voice).toBe(false);
    expect(snap!.can_send_other_messages).toBe(false);
  });

  it('⑥e2 只禁照片不禁视频 → 仍算能发媒体（五项里有一个没禁就算）', async () => {
    const snap = await getBotPermissions(botWith({
      status: 'restricted', can_send_photos: false, can_send_videos: true,
    }), CHAT);
    expect(snap!.can_send_media).toBe(true);
  });

  it('⑥f restricted 且没给 can_* → 按"未禁止"处理（fail-open 发言）', async () => {
    const snap = await getBotPermissions(botWith({ status: 'restricted' }), CHAT);
    expect(snap!.can_send_messages).toBe(true);
  });

  it('⑥g 读失败 → null（调用方要能区分"没权限"和"查不到"）', async () => {
    const broken = {
      api: {
        getMe: vi.fn().mockRejectedValue(new Error('boom')),
        getChatMember: vi.fn().mockRejectedValue(new Error('boom')),
        getChat: vi.fn().mockRejectedValue(new Error('boom')),
      },
    } as unknown as Bot;
    expect(await getBotPermissions(broken, CHAT)).toBeNull();
  });

  it('⑥h getMe 拿到的 id 才是被查的那个（不是硬编码 bot uid）', async () => {
    const getMe = vi.fn().mockResolvedValue({ id: 4242 });
    const getChatMember = vi.fn().mockResolvedValue({ status: 'member' });
    const b = { api: { getMe, getChatMember } } as unknown as Bot;
    await getBotPermissions(b, CHAT);
    expect(getChatMember).toHaveBeenCalledWith(CHAT, 4242);
  });
});
