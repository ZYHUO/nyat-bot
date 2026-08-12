import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/db/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { isHardStop } from '../../../src/agent/interrupts.js';

describe('isHardStop — 长任务硬停词(P1)', () => {
  it('明确喊停的短消息 → true', () => {
    for (const t of ['停', '停下', '停下来', '停止', '打住', '住手', '算了', '取消', '不用了',
      '别做了', '别搞了', '别弄了', '别画了', '别写了', '别发了', '先别做', '停!', '算了算了'.slice(0, 2),
      'stop', 'Stop!', 'cancel', 'halt', 'quit']) {
      expect(isHardStop(t), `"${t}" should be hard-stop`).toBe(true);
    }
  });

  it('长句里提到"停"不是指令 → false', () => {
    for (const t of [
      '那个服务停更是因为资金链断了',
      '你别停下来啊继续讲',
      '停车场在哪',
      '停止更新的公告发了吗',
      '任务做得怎么样了',
      '继续',
      '别停',
      '不要停',
      '进度如何',
      '加油',
      '?',
    ]) {
      expect(isHardStop(t), `"${t}" should NOT be hard-stop`).toBe(false);
    }
  });

  it('空串/超长 → false', () => {
    expect(isHardStop('')).toBe(false);
    expect(isHardStop('   ')).toBe(false);
    expect(isHardStop('停停停停停停停停停停停停停')).toBe(false); // 13 字超上限
  });
});
