// ────────────────────────────────────────
// Core v2 Phase 5 — /skill 主人命令（DM 专属）
//
// 门：chatId 必须是主人 DM（chatId>0 且 uid==MASTER_UID）。
// 非主人/群聊 → 返回拒绝语（不透露门存在）。
// 所有状态机调用走 lifecycle.ts（host 侧），reviewer=主人 uid。
// ────────────────────────────────────────

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import { getLifecycle, listLifecycle, verifySkill } from './lifecycle.js';
import { approveSkill } from './lifecycle.js';
import { publishSkill } from './lifecycle.js';

function isMasterDm(chatId: number, uid: number): boolean {
  try {
    return chatId > 0 && uid === env().MASTER_UID;
  } catch {
    return false;
  }
}

/**
 * 处理 /skill <sub> [id]。返回回复文本（null=没处理，不该发生）。
 * 纯 host 逻辑，不调 LLM。
 */
export async function handleSkillCommand(
  chatId: number,
  uid: number,
  arg: string,
): Promise<string | null> {
  if (!isMasterDm(chatId, uid)) {
    return '这个命令用不了喵~';
  }
  const [subRaw, idRaw] = arg.split(/\s+/, 2);
  const sub = (subRaw ?? '').toLowerCase();
  const id = Number(idRaw ?? '');

  if (sub === 'pending' || sub === '') {
    const proposed = listLifecycle('proposed', 20);
    const verified = listLifecycle('verified', 20);
    if (!proposed.length && !verified.length) return '门里没候选，干净喵~';
    const lines: string[] = [];
    for (const r of verified) lines.push(`#${r.id} ${r.name} —— 待批准（/skill approve ${r.id}）`);
    for (const r of proposed) lines.push(`#${r.id} ${r.name} —— 待验证（/skill verify ${r.id}）`);
    return `待审（${lines.length}）：\n${lines.join('\n')}`;
  }

  if (sub === 'show') {
    if (!idRaw || !Number.isFinite(id)) return '用法：/skill show <id>喵~';
    const r = getLifecycle(id);
    if (!r) return `没找到 #${idRaw} 喵~`;
    let body = '';
    try {
      const b = JSON.parse(r.verifyLog ?? '{}') as Record<string, unknown>;
      const tier = String(b['tier'] ?? 'small');
      const merged = Array.isArray(b['mergedFrom']) ? (b['mergedFrom'] as string[]).join('、') : '';
      body = [
        `触发：${String(b['triggerWhen'] ?? '-').slice(0, 200)}`,
        `步骤：${String(b['steps'] ?? '-').slice(0, 400)}`,
        `tier：${tier}${merged ? `（合自：${merged.slice(0, 200)}）` : ''}`,
      ].join('\n');
    } catch {
      body = r.verifyLog ?? '-';
    }
    return `#${r.id} ${r.name}（${r.status} v${r.version}）\n${body}`;
  }

  if (sub === 'verify') {
    if (!idRaw || !Number.isFinite(id)) return '用法：/skill verify <id>喵~';
    const r = verifySkill(id);
    logger.info({ id, ok: r.ok, reason: r.reason }, 'skill verify via /skill');
    return r.ok ? `#${id} 验证通过，待批准（/skill approve ${id}）喵~` : `#${id} 验证没过：${r.reason}喵~`;
  }

  if (sub === 'approve') {
    if (!idRaw || !Number.isFinite(id)) return '用法：/skill approve <id>喵~';
    const r = approveSkill(id, uid);
    logger.info({ id, reviewer: uid, ok: r.ok }, 'skill approve via /skill');
    return r.ok ? `#${id} 已批准，可以发布了（/skill publish ${id}）喵~` : `#${id} 批不了：${r.reason}喵~`;
  }

  if (sub === 'publish') {
    if (!idRaw || !Number.isFinite(id)) return '用法：/skill publish <id>喵~';
    const r = await publishSkill(id);
    logger.info({ id, ok: r.ok, reason: r.reason }, 'skill publish via /skill');
    return r.ok ? `#${id} 已发布进技能库喵~` : `#${id} 发不了：${r.reason}喵~`;
  }

  if (sub === 'reject') {
    if (!idRaw || !Number.isFinite(id)) return '用法：/skill reject <id>喵~';
    const row = getLifecycle(id);
    if (!row) return `没找到 #${idRaw} 喵~`;
    if (row.status !== 'proposed' && row.status !== 'verified') {
      return `#${id} 现在是 ${row.status}，驳不动喵~`;
    }
    const { getDb } = await import('../../db/sqlite.js');
    try {
      getDb().prepare(`UPDATE core_skill_lifecycle SET status='rejected', verify_log='rejected by master via /skill', updated_at=? WHERE id=?`).run(Math.floor(Date.now() / 1000), id);
      logger.info({ id, reviewer: uid }, 'skill rejected via /skill');
      return `#${id} 已驳回喵~`;
    } catch {
      return `#${id} 驳回失败喵~`;
    }
  }

  return '用法：/skill pending | show <id> | verify <id> | approve <id> | publish <id> | reject <id>喵~';
}
