// ────────────────────────────────────────
// Core v2 Phase 3 — drive store
//
// 读写 core_drives。更新只认 host 可验证 outcome（与 belief 同原则）：
// observe() 由 unified-tick 执行器调，LLM 不直接写。
//
// satiation 语义：某 drive 的行为刚执行过 → satiation=1（全抑制），
// 随时间指数衰减到 0。suppressor 看 satiation 不看 value。
// ────────────────────────────────────────

import { getDb } from '../../db/sqlite.js';
import { logger } from '../../shared/logger.js';
import { DRIVE_NAMES, type DriveName, type DriveState } from './types.js';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** satiation 半衰期：默认 6h（与 norms TTL 同量级）。可配 CORE_DRIVE_SATIATION_HALFLIFE_SEC。 */
function halflifeSec(): number {
  try {
    // 轻量读 env，不经过 env-shim 的重依赖（store 被多方 import，防循环）
    const v = Number(process.env['CORE_DRIVE_SATIATION_HALFLIFE_SEC'] ?? 21600);
    return Number.isFinite(v) && v > 0 ? v : 21600;
  } catch {
    return 21600;
  }
}

/** 指数衰减：satiation 随时间回落。纯函数。 */
export function decayedSatiation(s: number, ageSec: number, half: number): number {
  if (s <= 0) return 0;
  return s * Math.pow(0.5, ageSec / half);
}

function rowToState(row: Record<string, unknown>, half: number, now: number): DriveState {
  const raw = (row['satiation'] as number) ?? 0;
  const age = now - ((row['updated_at'] as number) ?? now);
  return {
    name: row['name'] as DriveName,
    value: (row['value'] as number) ?? 0.5,
    satiation: decayedSatiation(raw, Math.max(0, age), half),
    updatedAt: (row['updated_at'] as number) ?? now,
  };
}

/** 读全部四个 drive（缺行 → 默认值 0.5/0，不写库）。 */
export function getDrives(): DriveState[] {
  const now = nowSec();
  const half = halflifeSec();
  try {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM core_drives').all() as Record<string, unknown>[];
    const byName = new Map(rows.map((r) => [r['name'] as string, r]));
    return DRIVE_NAMES.map((name) => {
      const row = byName.get(name);
      if (!row) return { name, value: 0.5, satiation: 0, updatedAt: now };
      return rowToState(row, half, now);
    });
  } catch {
    return DRIVE_NAMES.map((name) => ({ name, value: 0.5, satiation: 0, updatedAt: now }));
  }
}

/**
 * host 记录 drive 值（每 tick 由 buildWorldState 派生，不由 LLM 写）。
 * value 夹到 0..1。
 */
export function setDriveValue(name: DriveName, value: number): void {
  try {
    const v = Math.min(1, Math.max(0, value));
    getDb()
      .prepare(
        `INSERT INTO core_drives (name, value, satiation, updated_at) VALUES (?, ?, 0, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(name, v, nowSec());
  } catch (err) {
    logger.debug({ err, name }, 'setDriveValue failed (non-critical)');
  }
}

/**
 * host 记录"某 drive 刚被满足" → satiation=1（全抑制，靠时间衰减恢复）。
 * 调用点：unified-tick executeVerdict 各动作执行后。
 */
export function satiate(name: DriveName): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO core_drives (name, value, satiation, updated_at) VALUES (?, 0.5, 1, ?)
         ON CONFLICT(name) DO UPDATE SET satiation = 1, updated_at = excluded.updated_at`,
      )
      .run(name, nowSec());
  } catch (err) {
    logger.debug({ err, name }, 'satiate failed (non-critical)');
  }
}

export function _resetDrivesForTest(): void {
  try {
    getDb().prepare('DELETE FROM core_drives').run();
  } catch {
    /* :memory: 无表时 */
  }
}
