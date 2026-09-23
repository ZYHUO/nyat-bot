import { describe, expect, it, vi } from 'vitest';

/**
 * round 63\uff1a\u8fdb\u7a0b\u542f\u52a8\u65f6\u8981\u8bb0\u4e00\u53e5"\u8fdb\u7a0b\u5185\u5b88\u536b\u5728\u8fd9\u91cc\u6e05\u96f6"\u3002
 *
 * Round 41-44 \u82b1\u4e86\u4e24\u8f6e\u624d\u660e\u767d\uff1a\u82e5\u5e72\u95f8\u7684\u5224\u636e\u72b6\u6001\u662f\u8fdb\u7a0b\u5185 Map\uff0c
 * \u91cd\u542f\u6e05\u96f6\u3002\u800c 09-22..23 \u91cd\u542f 111 \u6b21\uff08\u5e73\u5747\u8fdb\u7a0b\u5bff\u547d 21 \u5206\u949f\uff09\u3002
 *
 * \u6240\u4ee5"\u95f8\u62e2 0 \u6b21"\u8981\u8bfb\u6210"\u4ece\u6ca1\u88ab\u7ed9\u8fc7\u673a\u4f1a"\u3002\u8fd9\u53e5\u8bdd\u5e94\u8be5\u81ea\u52a8\u51fa\u73b0\u5728\u65e5\u5fd7\u91cc\u3002
 */

const { loggerInfoMock, logProcessBootContext } = vi.hoisted(() => {
  const loggerInfoMock = vi.fn();
  return {
    loggerInfoMock,
    // \u6a21\u5757\u662f\u9876\u5c42 import \u7684\uff0c\u8fd9\u91cc\u5148\u5360\u4f4d\uff1b\u771f\u6a21\u5757\u5728\u4e0b\u9762 await import \u540e\u53d6\u3002
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
    expect(note).toContain('recentBotTextsByChat');   // \u6e05\u96f6\u7684\u5177\u4f53\u5bf9\u8c61
    expect(note).toContain('never given a chance');  // 0 \u6b21\u7684\u542b\u4e49
    expect(note).toContain('21 min');                // \u6570\u636e\u6765\u6e90
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
