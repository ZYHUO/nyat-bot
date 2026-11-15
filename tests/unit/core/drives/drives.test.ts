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
    expect(suppress({ type: 'group_speak', chatId: -100 }, states)).toContain('satiated');
    expect(suppress({ type: 'remember_user', chatId: -100 }, states)).toContain('satiated:connection');
    // check_goal 服务 competence（没被 satiate）→ 放行
    expect(suppress({ type: 'check_goal', goalId: 1 }, states)).toBeNull();
    expect(suppress({ type: 'quiet' }, states)).toBeNull();
  });

  it('care_master（私聊主人）不被群里的 group_speak 造成的 connection 饱和连带封住', () => {
    // 群里说了一句话 → connection 被打满。主人 DM 的关心不该因此被封 6 小时
    // （线上：care_master 被 satiated:connection 否决 39 次，而它自己只发出过 12 次）。
    satiate('connection');
    const states = getDrives();
    expect(states.find((s) => s.name === 'connection')!.satiation).toBeGreaterThanOrEqual(0.5);
    expect(suppress({ type: 'care_master' }, states)).toBeNull();
    // 对照：群内发言仍被同一个饱和拦住（防刷屏的核心没动）
    expect(suppress({ type: 'group_speak', chatId: -100 }, states)).toContain('satiated:connection');
    expect(suppress({ type: 'remember_user', chatId: -100 }, states)).toContain('satiated:connection');
    expect(suppress({ type: 'share', fromChatId: -1, toChatId: -2 }, states)).toContain('satiated');
  });

  it('autonomy 饱和仍拦 self_play（它自己的闸没被这次改动放松）', () => {
    satiate('autonomy');
    expect(suppress({ type: 'self_play' }, getDrives())).toContain('satiated:autonomy');
  });

  it('drivesServedBy 覆盖全部动作类型', () => {
    expect(drivesServedBy({ type: 'quiet' })).toEqual([]);
    expect(drivesServedBy({ type: 'self_play' })).toContain('autonomy');
  });
});
