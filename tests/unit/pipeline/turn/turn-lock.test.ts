// G12 执行期互斥锁:SET NX 语义 + token 比对续期/释放
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
const redisMock = {
  set: vi.fn(async (k: string, v: string, ...args: unknown[]) => {
    if (args.includes('NX') && store.has(k)) return null;
    store.set(k, v);
    return 'OK';
  }),
  eval: vi.fn(async (script: string, _numKeys: number, key: string, token: string) => {
    // 模拟两段 Lua 的 GET-比对语义(足够覆盖 token 守卫)
    if (store.get(key) !== token) return 0;
    if (script.includes('PEXPIRE')) return 1;   // renew:比对通过 → 续期
    store.delete(key);                           // release:比对通过 → DEL
    return 1;
  }),
};
vi.mock('../../../../src/db/redis.js', () => ({ getRedis: () => redisMock }));

const { acquireTurnLock, renewTurnLock, releaseTurnLock } = await import(
  '../../../../src/pipeline/turn/turn-lock.js'
);

const CHAT = -100700;

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('turn-lock', () => {
  it('acquire:空锁拿到(PX+NX);已被持有 → false', async () => {
    expect(await acquireTurnLock(CHAT, 'tok-a', 120_000)).toBe(true);
    expect(redisMock.set).toHaveBeenCalledWith(
      `xxb:turn:execlock:${CHAT}`, 'tok-a', 'PX', 120_000, 'NX',
    );
    expect(await acquireTurnLock(CHAT, 'tok-b', 120_000)).toBe(false);
  });

  it('release:仅 token 匹配时删除 —— TTL 过期后接手的新回合不被旧 finally 误删', async () => {
    await acquireTurnLock(CHAT, 'tok-a', 120_000);
    await releaseTurnLock(CHAT, 'tok-stale'); // 不匹配 → 不删
    expect(store.has(`xxb:turn:execlock:${CHAT}`)).toBe(true);
    await releaseTurnLock(CHAT, 'tok-a');
    expect(store.has(`xxb:turn:execlock:${CHAT}`)).toBe(false);
  });

  it('renew:token 匹配 → true;不匹配 → false', async () => {
    await acquireTurnLock(CHAT, 'tok-a', 120_000);
    expect(await renewTurnLock(CHAT, 'tok-a', 120_000)).toBe(true);
    expect(await renewTurnLock(CHAT, 'tok-other', 120_000)).toBe(false);
  });

  it('释放后可被再次获取(串行回合交接)', async () => {
    await acquireTurnLock(CHAT, 'tok-a', 120_000);
    await releaseTurnLock(CHAT, 'tok-a');
    expect(await acquireTurnLock(CHAT, 'tok-b', 120_000)).toBe(true);
  });
});
