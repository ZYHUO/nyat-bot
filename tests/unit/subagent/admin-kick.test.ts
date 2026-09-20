/**
 * admin.kick —— 踢人是不可逆动作，锁它的安全边界。
 *
 * 默认不可用；群主明确开（ANTIAD_KICK_ENABLED）才有；
 * 主人和自己永远踢不到；需要 restrict 权限；走同一个每小时 10 次的 rateGate。
 *
 * 这里测的是**闸门本身**（在 host 的 admin 面上），不打真 TG API。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  it('总闸默认关（ANTIAD_KICK_ENABLED !== true 就抛）', () => {
    expect(SRC).toContain("if (env().ANTIAD_KICK_ENABLED !== true) {");
    expect(SRC).toContain('admin_kick_disabled');
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
    expect(body).toContain('admin_no_self');
    expect(body).toContain('getBotUid()');
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

  it('模型侧工具说明里写了"最后手段"', () => {
    const ex = readFileSync('src/subagent/executor.ts', 'utf8');
    expect(ex).toContain('admin.kick(uid');
    expect(ex).toContain('踢人是最后手段');
  });
});
