/**
 * 长轮询死了要能自己爬起来。
 *
 * 2026-09-28 22:54 → 09-30 10:37 的 171 次重启：别的进程用同一 token 调了 getUpdates，
 * grammY 收到 409 后 rethrow，`void bot.start()` 的 reject 只落进 unhandledRejection，
 * 轮询停、进程活、心跳不更新；5 分钟后 failover 看门狗 exit(0)，systemd 拉起。
 * 每个周期 6.5 分钟活 + 5 分钟装死，进程内状态每 12 分钟归零。
 *
 * 这里锁的是：409 → 退避后原地重开轮询；401 → 明确 exit(1)；正常返回 → 不重试。
 */
import { describe, it, expect, vi } from 'vitest';
import { GrammyError } from 'grammy';
import {
  startPollingWithRecovery,
  classifyPollingError,
  backoffMs,
} from '../../../src/ingress/polling-recovery.js';

vi.mock('../../../src/shared/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { ...l, child: () => l } };
});

function grammy409(): GrammyError {
  return new GrammyError(
    "Call to 'getUpdates' failed!",
    { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' },
    'getUpdates',
    {},
  );
}
function grammy401(): GrammyError {
  return new GrammyError(
    "Call to 'getUpdates' failed!",
    { ok: false, error_code: 401, description: 'Unauthorized' },
    'getUpdates',
    {},
  );
}

describe('classifyPollingError', () => {
  it('409 → conflict；401 → unauthorized；其它 → other', () => {
    expect(classifyPollingError(grammy409())).toBe('conflict');
    expect(classifyPollingError(grammy401())).toBe('unauthorized');
    expect(classifyPollingError(new Error('ECONNRESET'))).toBe('other');
  });
});

describe('backoffMs', () => {
  it('3s 起翻倍，封顶 60s', () => {
    expect(backoffMs(1)).toBe(3_000);
    expect(backoffMs(2)).toBe(6_000);
    expect(backoffMs(3)).toBe(12_000);
    expect(backoffMs(10)).toBe(60_000);
  });
});

describe('startPollingWithRecovery', () => {
  it('409 两次后恢复 → start 被调 3 次、退避 3s/6s、onStart 照常触发、不 exit', async () => {
    const onStart = vi.fn();
    const sleep = vi.fn(async () => {});
    const exit = vi.fn();
    let calls = 0;
    const start = vi.fn(async (opts: { onStart?: (me: unknown) => unknown }) => {
      calls += 1;
      if (calls <= 2) throw grammy409();
      await opts.onStart?.({ id: 1 });
      // 第三次：轮询正常跑到 stop()
    });
    await startPollingWithRecovery({ onStart }, { start, sleep, exit });
    expect(start).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([3_000, 6_000]);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('401 → exit(1)，不再重试', async () => {
    const sleep = vi.fn(async () => {});
    const exit = vi.fn();
    const start = vi.fn(async () => { throw grammy401(); });
    await startPollingWithRecovery({}, { start, sleep, exit });
    expect(start).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('网络类错误（非 GrammyError）也重试', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const start = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('fetch failed');
    });
    await startPollingWithRecovery({}, { start, sleep, exit: vi.fn() });
    expect(start).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it('恢复成功后 attempt 归零：下一次死亡从 3s 重新起算', async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const start = vi.fn(async (opts: { onStart?: (me: unknown) => unknown }) => {
      calls += 1;
      if (calls === 1 || calls === 2) throw grammy409(); // 3s, 6s
      if (calls === 3) { await opts.onStart?.({ id: 1 }); throw grammy409(); } // 活过一段再死 → 3s
      // calls === 4: 正常
    });
    await startPollingWithRecovery({}, { start, sleep, exit: vi.fn() });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([3_000, 6_000, 3_000]);
  });
});
