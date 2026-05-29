// ────────────────────────────────────────
// Group feature toggles (group_features table)
// Lets group admins enable/disable DM-relay features per group.
// ────────────────────────────────────────

import { getDb } from '../../db/sqlite.js';
import { getRedis } from '../../db/redis.js';
import { getBot } from '../../bot/bot.js';
import { logger } from '../../shared/logger.js';

const CACHE_PREFIX = 'xxb:group:feature:';
const CACHE_TTL = 60; // 1 min

/** Canonical feature keys (must match handlers' gate calls). */
export const FEATURE_KEYS = [
  'relay',
  'view_group',
  'note',
  'profile',
  'schedule',
  'confide',
  'fate',
] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Human-friendly names for the /feature command listing. */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  relay: '捎话/传话',
  view_group: '看群消息',
  note: '匿名纸条',
  profile: '群友档案',
  schedule: '定时提醒',
  confide: '树洞',
  fate: '缘分签',
};

export function isValidFeature(name: string): name is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(name);
}

/**
 * Check whether a feature is enabled in a group. Defaults to TRUE (opt-out model).
 * Synchronous SQLite read; cached separately via isFeatureEnabledCached for hot paths.
 */
export function isFeatureEnabled(groupId: number, feature: FeatureKey): boolean {
  const row = getDb().prepare(
    'SELECT enabled FROM group_features WHERE group_id = ? AND feature = ?',
  ).get(groupId, feature) as { enabled: number } | undefined;
  // No row = default enabled
  return row ? row.enabled === 1 : true;
}

/**
 * Cached async variant for hot paths. Returns default TRUE on any error.
 */
export async function isFeatureEnabledCached(groupId: number, feature: FeatureKey): Promise<boolean> {
  const redis = getRedis();
  const key = `${CACHE_PREFIX}${groupId}:${feature}`;
  try {
    const cached = await redis.get(key);
    if (cached === '1') return true;
    if (cached === '0') return false;
  } catch { /* fall through to DB */ }

  const enabled = isFeatureEnabled(groupId, feature);
  try {
    await redis.set(key, enabled ? '1' : '0', 'EX', CACHE_TTL);
  } catch { /* best effort */ }
  return enabled;
}

/** Enable/disable a feature for a group (UPSERT) + bust cache. */
export async function setFeature(groupId: number, feature: FeatureKey, enabled: boolean): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO group_features (group_id, feature, enabled, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(group_id, feature) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(groupId, feature, enabled ? 1 : 0, now);
  try {
    await getRedis().del(`${CACHE_PREFIX}${groupId}:${feature}`);
  } catch { /* best effort */ }
}

/** List all feature states for a group (default enabled when no row). */
export function listFeatures(groupId: number): Array<{ feature: FeatureKey; enabled: boolean }> {
  const rows = getDb().prepare(
    'SELECT feature, enabled FROM group_features WHERE group_id = ?',
  ).all(groupId) as Array<{ feature: string; enabled: number }>;
  const map = new Map(rows.map((r) => [r.feature, r.enabled === 1]));
  return FEATURE_KEYS.map((feature) => ({ feature, enabled: map.get(feature) ?? true }));
}

/** Check whether a user is an admin/creator of a group (via Telegram API). */
export async function isGroupAdmin(groupId: number, uid: number): Promise<boolean> {
  try {
    const member = await getBot().api.getChatMember(groupId, uid);
    return member.status === 'administrator' || member.status === 'creator';
  } catch (err) {
    logger.warn({ err, groupId, uid }, 'isGroupAdmin: getChatMember failed');
    return false;
  }
}

/**
 * Gate check for a DM feature that publishes to a group.
 * Returns a rejection message if disabled, or null if allowed.
 */
export async function checkFeatureGate(groupId: number, feature: FeatureKey): Promise<string | null> {
  if (await isFeatureEnabledCached(groupId, feature)) return null;
  return `这个群关闭了「${FEATURE_LABELS[feature]}」功能喵~`;
}

/**
 * Handle the `/feature` group command. Returns reply text.
 * `arg` is everything after the command, e.g. "note off" / "" (list).
 * Only group admins / master may toggle.
 */
export async function handleFeatureCommand(
  groupId: number,
  uid: number,
  arg: string,
  isMasterUser: boolean,
): Promise<string> {
  const trimmed = arg.trim();

  // No args → list current states
  if (!trimmed) {
    const states = listFeatures(groupId);
    const lines = states.map(
      (s) => `${s.enabled ? '✅' : '🚫'} ${s.feature} — ${FEATURE_LABELS[s.feature]}`,
    );
    return `📋 本群功能开关：\n\n${lines.join('\n')}\n\n群管可用：/feature <名称> on|off`;
  }

  // Toggle → admin only
  const admin = isMasterUser || (await isGroupAdmin(groupId, uid));
  if (!admin) {
    return '只有群管理员才能开关功能喵~';
  }

  const parts = trimmed.split(/\s+/);
  const name = (parts[0] ?? '').toLowerCase();
  const action = (parts[1] ?? '').toLowerCase();

  if (!isValidFeature(name)) {
    return `不认识的功能「${name}」喵~ 可用：${FEATURE_KEYS.join(' / ')}`;
  }
  if (action !== 'on' && action !== 'off') {
    return '请指定 on 或 off 喵~ 例如：/feature note off';
  }

  const enabled = action === 'on';
  await setFeature(groupId, name, enabled);
  return `${enabled ? '✅ 已开启' : '🚫 已关闭'}「${FEATURE_LABELS[name]}」功能喵~`;
}
