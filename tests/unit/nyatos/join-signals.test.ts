/**
 * 入群账号信号。
 *
 * 用户给的判据：没头像 + 名字像乱写 + 注册新 = ad 人。
 * 锁三件事：
 *   1. 三个信号都以**事实**呈现，没有"三者齐备就踢"的规则（那正是用户不要的）
 *   2. 头像查不到是 null（未知），不能当成"没有"
 *   3. "首次见到"不被二次改写
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
const redisMock = {
  get: vi.fn(async (k: string) => store.get(k) ?? null),
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
};
vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const m = await import('../../../src/nyatos/join-signals.js');
beforeEach(() => { store.clear(); redisMock.get.mockClear(); redisMock.set.mockClear(); });

describe('入群账号信号', () => {
  it('名字形态是事实描述，不是判定', () => {
    const n = m.nameShapeNote('xK9mQ2pLwR7v');
    expect(n).toContain('12 字符');
    expect(n).toContain('纯字母数字无空格');
    expect(n).not.toMatch(/广告|ad|可疑/);   // 不下结论
    expect(m.nameShapeNote('Amanda Hayes')).toContain('有空格');
    expect(m.nameShapeNote('vip德州 （kuku玳）')).toContain('含中文');
  });

  it('头像查不到是 null，不是 false', async () => {
    const bot = { api: { getUserProfilePhotos: async () => { throw new Error('blocked'); } } };
    expect(await m.checkHasPhoto(bot as never, 123)).toBeNull();
  });

  it('有头像/无头像分别可判', async () => {
    const yes = { api: { getUserProfilePhotos: async () => ({ total_count: 3 }) } };
    const no = { api: { getUserProfilePhotos: async () => ({ total_count: 0 }) } };
    expect(await m.checkHasPhoto(yes as never, 1)).toBe(true);
    expect(await m.checkHasPhoto(no as never, 1)).toBe(false);
  });

  it('"首次见到"只写一次，不被改写', async () => {
    const t0 = 1_800_000_000;
    expect(await m.noteFirstSeen(555, t0)).toBe(t0);
    expect(await m.noteFirstSeen(555, t0 + 7200)).toBe(t0);   // 第二次不改写
  });

  it('呈现含三件事实且不含裁决词', async () => {
    const s = { uid: 1, hasPhoto: false, firstSeenAt: 1_800_000_000, knownForSec: 60, nameShapeNote: '12 字符，纯字母数字无空格' };
    const out = m.renderJoinSignals(s, 'xK9mQ2pLwR7v');
    expect(out).toContain('没有头像');
    expect(out).toContain('第一次见到');
    expect(out).toContain('你判');
    expect(out).toContain('机场/代理');
    expect(out).not.toContain('踢');
  });
});
