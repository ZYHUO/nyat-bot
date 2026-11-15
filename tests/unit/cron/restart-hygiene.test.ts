import { describe, expect, it, vi } from 'vitest';

/**
 * round 63：进程启动时要记一句"进程内守卫在这里清零"。
 *
 * Round 41-44 花了两轮才明白：若干闸的判据状态是进程内 Map，
 * 重启清零。而 09-22..23 重启 111 次\uff08平均进程寿命 21 分钟\uff09。
 *
 * 所以"闸拢 0 次"要读成"从没被给过机会"。这句话应该自动出现在日志里。
 */

const { loggerInfoMock, logProcessBootContext } = vi.hoisted(() => {
  const loggerInfoMock = vi.fn();
  return {
    loggerInfoMock,
    // 模块是顶层 import 的，这里先占位；真模块在下面 await import 后取。
    logProcessBootContext: null as unknown as () => Promise<void>,
  };
});

vi.mock('../../../src/shared/logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => loggerInfoMock(...a),
    warn: vi.fn(), debug: vi.fn(), error: vi.fn(),
  },
}));

const mod = await import('../../../src/cron/restart-hygiene.js');

describe('进程启动时记一句"进程内守卫已清零"', () => {
  it('① 打的 info 带 bootedAtSec 时间戳', async () => {
    loggerInfoMock.mockClear();
    await mod.logProcessBootContext();
    expect(loggerInfoMock).toHaveBeenCalledTimes(1);
    const payload = loggerInfoMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(typeof payload['bootedAtSec']).toBe('number');
  });

  it('② note 说清三件事：清零在哪、0 次意味着什么、数据来源（round 44 的 21 分钟）', async () => {
    loggerInfoMock.mockClear();
    await mod.logProcessBootContext();
    const payload = loggerInfoMock.mock.calls[0]![0] as Record<string, unknown>;
    const note = String(payload['note'] ?? '');
    expect(note).toContain('recentBotTextsByChat');   // 清零的具体对象
    expect(note).toContain('never given a chance');  // 0 次的含义
    expect(note).toContain('21 min');                // 数据来源
  });

  it('③ msg 名稳定（gate:evidence / session-report 要能 grep 到）', async () => {
    loggerInfoMock.mockClear();
    await mod.logProcessBootContext();
    expect(loggerInfoMock.mock.calls[0]![1]).toBe('process boot context (in-process guards reset)');
  });

  it('④ index.ts 真的调了它（不是只定义了）', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/index.ts', 'utf8');
    const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.some((l) => l.includes('logProcessBootContext()'))).toBe(true);
  });
});
