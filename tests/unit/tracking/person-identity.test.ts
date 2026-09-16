import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const testDb = new Database(':memory:');
testDb.exec(`CREATE TABLE person_identity (
  uid INTEGER PRIMARY KEY, impression TEXT, primary_chat_id INTEGER,
  chat_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`);

const mockGroups = vi.fn();
const mockAgg = vi.fn();
const mockProfile = vi.fn();

vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => testDb }));
vi.mock('../../../src/env.js', () => ({ env: () => ({
  PERSON_IDENTITY_ENABLED: true,
  PROFILE_MERGE_ENABLED: false,
  MEMORY_VISIBILITY_ENABLED: true,
  MEMORY_SENSITIVE_CHAT_IDS: [] as number[],
  DM_AUTO_PRIVATE: true,
}) }));
// 机制2:refreshPersonIdentity 改用 getUserContexts(群 ∪ DM);mockGroups 现表示"上下文集合"。
vi.mock('../../../src/pipeline/context/manager.js', () => ({
  getUserGroups: (...a: unknown[]) => mockGroups(...a),
  getUserContexts: (...a: unknown[]) => mockGroups(...a),
}));
vi.mock('../../../src/tracking/user-affinity.js', () => ({ getAggregatedAffinity: (...a: unknown[]) => mockAgg(...a) }));
vi.mock('../../../src/tracking/user-profile.js', () => ({ getUserProfilePrompt: (...a: unknown[]) => mockProfile(...a) }));

import { refreshPersonIdentity, getPersonIdentity, buildCrossGroupInjection } from '../../../src/tracking/person-identity.js';

describe('person-identity (cross-group)', () => {
  beforeEach(() => {
    testDb.exec('DELETE FROM person_identity');
    vi.clearAllMocks();
    mockAgg.mockReturnValue({ primaryChatId: -100, affinity: 50 });
    mockProfile.mockReturnValue('喜欢猫、住在浙江、爱打游戏');
  });

  it('writes a throttle tombstone (no impression) for someone seen in only one group', async () => {
    mockGroups.mockResolvedValue([-100]);
    const row = await refreshPersonIdentity(7);
    expect(row).not.toBeNull();
    expect(row!.impression).toBeNull();          // tombstone — nothing to inject
    expect(row!.chat_count).toBe(1);
    expect(getPersonIdentity(7)?.updated_at).toBeGreaterThan(0); // updated_at advanced → stale gate throttles
    expect(buildCrossGroupInjection(7, -100)).toBeNull();
  });

  it('dedups concurrent refreshes for the same uid', async () => {
    let resolveGroups: (g: number[]) => void = () => {};
    mockGroups.mockReturnValue(new Promise((r) => { resolveGroups = r; }));
    const p1 = refreshPersonIdentity(8);
    const p2 = refreshPersonIdentity(8); // in-flight → should not start a second getUserGroups
    resolveGroups([-1, -2]);
    await Promise.all([p1, p2]);
    expect(mockGroups).toHaveBeenCalledTimes(1);
  });

  it('aggregates the primary (highest-affinity) group profile as the cross-group impression', async () => {
    mockGroups.mockResolvedValue([-100, -200, -300]);
    const row = await refreshPersonIdentity(7);
    expect(row).not.toBeNull();
    expect(row!.chat_count).toBe(3);
    expect(row!.primary_chat_id).toBe(-100);
    expect(row!.impression).toContain('喜欢猫');
    expect(mockProfile).toHaveBeenCalledWith(-100, 7); // pulled from the primary group
  });

  it('injects the cross-group block in OTHER groups, but not in the primary group', async () => {
    const now = Math.floor(Date.now() / 1000);
    testDb.prepare('INSERT INTO person_identity (uid, impression, primary_chat_id, chat_count, updated_at) VALUES (?,?,?,?,?)')
      .run(7, '喜欢猫、爱打游戏', -100, 3, now);
    const inOther = buildCrossGroupInjection(7, -999);
    expect(inOther).toContain('别的地方也认识'); // 机制3:文案从"群"改"地方(含DM)"
    expect(inOther).toContain('喜欢猫');
    const inPrimary = buildCrossGroupInjection(7, -100);
    expect(inPrimary).toBeNull(); // primary group already has its own per-group profile
  });

  it('returns null when no identity exists yet', () => {
    expect(buildCrossGroupInjection(999, -1)).toBeNull();
  });
});
