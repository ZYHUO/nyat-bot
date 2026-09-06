import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';

let db: Database.Database;
vi.mock('../../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getDrives, setDriveValue, satiate, decayedSatiation } from '../../../../src/core/drives/store.js';
import {
  deriveDriveValues,
  scoreAction,
  suppress,
  drivesServedBy,
} from '../../../../src/core/drives/score.js';

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(readFileSync('migrations/0085_core_drives.sql', 'utf8'));
});

describe('drive store', () => {
  it('空库 → 默认值 0.5/0', () => {
    const ds = getDrives();
    expect(ds).toHaveLength(4);
    expect(ds.every((d) => d.value === 0.5 && d.satiation === 0)).toBe(true);
  });

  it('setDriveValue 夹到 0..1', () => {
    setDriveValue('connection', 9);
    setDriveValue('curiosity', -3);
    const ds = getDrives();
    expect(ds.find((d) => d.name === 'connection')!.value).toBe(1);
    expect(ds.find((d) => d.name === 'curiosity')!.value).toBe(0);
  });

  it('satiate → 1，随半衰期衰减（纯函数）', () => {
    satiate('connection');
    expect(getDrives().find((d) => d.name === 'connection')!.satiation).toBeCloseTo(1);
    // 1 个半衰期后 0.5
    expect(decayedSatiation(1, 21600, 21600)).toBeCloseTo(0.5);
    // 4 个半衰期后 ~0.06（基本恢复）
    expect(decayedSatiation(1, 86400, 21600)).toBeCloseTo(0.0625);
  });
});

describe('drive scorer', () => {
  const world = {
    masterSilentSec: 8 * 3600,
    lastCareAgoSec: 25 * 3600,
    groups: [{ chatId: -100, silentSec: 3 * 3600 }],
    dueGoals: [{ id: 1 }, { id: 2 }],
    rssNewCount: 5,
    absentUsers: [{ chatId: -100, uid: 1 }],
    selfPlayCooldownLeftSec: 0,
    lifeTransition: null,
  };

  it('deriveDriveValues: 有料的世界 → 高分', () => {
    const v = deriveDriveValues(world);
    expect(v.connection).toBeGreaterThan(0.5);
    expect(v.competence).toBeCloseTo(0.6);
    expect(v.autonomy).toBe(0.7);
  });

  it('deriveDriveValues: 空世界 → 低分（quiet 占优）', () => {
    const v = deriveDriveValues({
      masterSilentSec: 60,
      lastCareAgoSec: 60,
      groups: [],
      dueGoals: [],
      rssNewCount: 0,
      absentUsers: [],
      selfPlayCooldownLeftSec: 9999,
      lifeTransition: null,
    });
    expect(v.connection).toBeLessThan(0.2);
    expect(v.competence).toBe(0);
    expect(v.autonomy).toBe(0.1);
  });

  it('scoreAction: quiet 恒 0；check_goal 随 competence 走', () => {
    const v = deriveDriveValues(world);
    expect(scoreAction({ type: 'quiet' }, v)).toBe(0);
    expect(scoreAction({ type: 'check_goal', goalId: 1 }, v)).toBeCloseTo(v.competence);
    expect(scoreAction({ type: 'care_master' }, v)).toBeCloseTo(v.connection);
  });

  it('suppress: 刚满足过的 drive 否决同类动作，quiet 永不拦', () => {
    satiate('connection');
    const states = getDrives();
    expect(suppress({ type: 'care_master' }, states)).toContain('satiated:connection');
    expect(suppress({ type: 'group_speak', chatId: -100 }, states)).toContain('satiated');
    // check_goal 服务 competence（没被 satiate）→ 放行
    expect(suppress({ type: 'check_goal', goalId: 1 }, states)).toBeNull();
    expect(suppress({ type: 'quiet' }, states)).toBeNull();
  });

  it('drivesServedBy 覆盖全部动作类型', () => {
    expect(drivesServedBy({ type: 'quiet' })).toEqual([]);
    expect(drivesServedBy({ type: 'self_play' })).toContain('autonomy');
  });
});
