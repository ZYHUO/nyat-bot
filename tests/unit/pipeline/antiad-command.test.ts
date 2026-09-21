import { describe, expect, it, vi, beforeEach } from 'vitest';

// round 135 回归：用户在 uzumaru 群说"开一下反广告"什么都没发生——
// 命令被 interrupt 吸进长任务，而 admin.setAntiAd 生产调用 0 次。
// 现在有确定性路径，这些测试锁住它的三个性质：
//   ① 认得出开/关句式   ② 非管理员 fail-closed   ③ 管理员才真办

const setAntiAd = vi.fn(async () => {});
const isGroupAdmin = vi.fn(async () => true);
const sendDirect = vi.fn(async () => {});

vi.mock('../../../src/nyatos/ad-pressure.js', () => ({ setAntiAd: (...a: unknown[]) => setAntiAd(...a) }));
vi.mock('../../../src/admin/bot-permission.js', () => ({ isGroupAdmin: (...a: unknown[]) => isGroupAdmin(...a) }));
vi.mock('../../../src/bot/bot.js', () => ({ getBot: () => ({}) }));
vi.mock('../../../src/pipeline/shared.js', () => ({ sender: { sendDirect: (...a: unknown[]) => sendDirect(...a) } }));

import { tryAntiAdCommand } from '../../../src/pipeline/stages/antiad-command.js';

const msg = (text: string, uid = 111) => ({ textContent: text, uid, messageId: 1 }) as never;

describe('antiad 确定性命令路径', () => {
  beforeEach(() => { setAntiAd.mockClear(); isGroupAdmin.mockClear(); sendDirect.mockClear(); isGroupAdmin.mockResolvedValue(true); });

  it('① 认得出"开一下反广告"这类句式并真的开', async () => {
    expect(await tryAntiAdCommand(-100, msg('开一下反广告'))).toBe(true);
    expect(setAntiAd).toHaveBeenCalledWith(-100, true);
    expect(sendDirect).toHaveBeenCalled();
  });

  it('①b 关也认得出', async () => {
    expect(await tryAntiAdCommand(-100, msg('关闭反广告'))).toBe(true);
    expect(setAntiAd).toHaveBeenCalledWith(-100, false);
  });

  it('①c 不相关的句子不接', async () => {
    expect(await tryAntiAdCommand(-100, msg('今天天气怎么样'))).toBe(false);
    expect(setAntiAd).not.toHaveBeenCalled();
  });

  it('② 非管理员 → fail-closed，不开', async () => {
    isGroupAdmin.mockResolvedValue(false);
    expect(await tryAntiAdCommand(-100, msg('开一下反广告'))).toBe(true);
    expect(setAntiAd).not.toHaveBeenCalled();
    expect(sendDirect).toHaveBeenCalled();
  });

  it('③ 请求里带 uid=0（模型没传）也按非管理员处理', async () => {
    expect(await tryAntiAdCommand(-100, msg('开一下反广告', 0))).toBe(true);
    expect(setAntiAd).not.toHaveBeenCalled();
  });
});
