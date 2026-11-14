/**
 * admin.kick —— 踢人是不可逆动作，锁它的安全边界。
 *
 * 默认不可用；群主明确开（ANTIAD_KICK_ENABLED）才有；
 * 主人和自己永远踢不到；需要 restrict 权限；走同一个每小时 10 次的 rateGate。
 *
 * 这里测的是**闸门本身**（在 host 的 admin 面上），不打真 TG API。
 */
import { describe, it, expect, vi } from 'vitest';
import { buildCodeActSystemPrompt } from '../../../src/subagent/capability-prompt.js';
import { CODEACT_CAPABILITY_METHODS, selectCodeActCapabilities } from '../../../src/sandbox/codeact/capabilities.js';

const envMock: Record<string, unknown> = {
  ANTIAD_KICK_ENABLED: false,
  MASTER_UID: 6251541967,
  CODEACT_ADMIN_ENABLED: true,
};
vi.mock('../../../src/env.js', () => ({ env: () => envMock }));

// host-api 依赖很多，这里只取它导出的守卫相关纯函数不可行（admin 面是闭包）。
// 所以改为锁"闸门语义"：源码里 kick 必须排在权限/速率/主人/自己四道闸之后，
// 且总闸是 ANTIAD_KICK_ENABLED === true。这是防回归，不是防逻辑错。
import { readFileSync } from 'node:fs';

const SRC = readFileSync('src/subagent/host-api.ts', 'utf8');

describe('admin.kick 的安全边界', () => {
  it('总闸默认关，且与反广告授权共用一把钥匙', () => {
    // 全局开关关着 → 抛
    expect(SRC).toContain('admin_kick_disabled');
    // 但该群若已授权反广告（= 群主要了反广告），也视为授权踢人——
    // 否则群主开了反广告却不能让 bot 处理，是最差的半开状态。
    expect(SRC).toContain('antiAdEnabled(chatId)');
    expect(SRC).toContain('ANTIAD_KICK_ENABLED === true ||');
  });

  it('不许对主人下手', () => {
    const i = SRC.indexOf('async kick(uid: number');
    const body = SRC.slice(i, i + 1400);
    expect(body).toContain('admin_no_master');
    expect(body).toContain('env().MASTER_UID');
  });

  it('不能踢自己', () => {
    const i = SRC.indexOf('async kick(uid: number');
    const body = SRC.slice(i, i + 1400);
    const selfGuard = body.indexOf("if (target === getBotUid(chatId)) throw new Error('admin_no_self:");
    expect(selfGuard).toBeGreaterThanOrEqual(0);
    expect(body).not.toContain('getBotUid()');
    // 自身保护必须使用当前会话的账号身份，并在真正踢人之前执行。
    const kick = body.indexOf('await kickMember(chatId, target,');
    expect(kick).toBeGreaterThan(selfGuard);
  });

  it('要 restrict 权限且走 rateGate', () => {
    const i = SRC.indexOf('async kick(uid: number');
    const body = SRC.slice(i, i + 1400);
    expect(body).toContain("assertAdminPerm('can_restrict_members')");
    expect(body).toContain('await rateGate()');
  });

  it('kickMember 是 ban+unban（可被重新加回，不是永久封杀）', () => {
    const t = readFileSync('src/bot/sender/telegram.ts', 'utf8');
    const i = t.indexOf('export async function kickMember');
    const body = t.slice(i, i + 700);
    expect(body).toContain('banChatMember');
    expect(body).toContain('unbanChatMember');
  });

  it('deleteMessages 是 opt-in 且失败不影响踢人本身', () => {
    const t = readFileSync('src/bot/sender/telegram.ts', 'utf8');
    const i = t.indexOf('export async function kickMember');
    const body = t.slice(i, i + 900);
    expect(body).toContain('if (deleteMessages)');
    expect(body).toContain('catch');
  });

  it('群主自助授权有管理员校验（fail-closed）', () => {
    const t = readFileSync('src/subagent/host-api.ts', 'utf8');
    const i = t.indexOf('async setAntiAd(');
    const body = t.slice(i, i + 900);
    expect(body).toContain('isGroupAdmin');
    expect(body).toContain('admin_not_group_admin');
    // 发起人 uid 缺失或 <=0 时也要拒绝
    expect(body).toContain('asker > 0');
  });

  it('宿主群管理守卫保留，但隔离模型没有 kick 能力或对应提示', () => {
    const ex = readFileSync('src/subagent/executor.ts', 'utf8');
    const template = ex.match(/const EXECUTOR_SYSTEM = `([\s\S]*?)\n`;/)?.[1];
    expect(template).toBeTruthy();
    expect(buildCodeActSystemPrompt(template!)).not.toContain('admin.kick');
    const kick = vi.fn();
    const selected = selectCodeActCapabilities({ admin: { kick }, telegram: { sendText: vi.fn() } }, CODEACT_CAPABILITY_METHODS);
    expect(selected.has('admin.kick')).toBe(false);
    expect(selected.has('telegram.sendText')).toBe(true);
    expect(kick).not.toHaveBeenCalled();
  });
});
