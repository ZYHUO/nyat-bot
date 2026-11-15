import { beforeEach, describe, expect, it, vi } from 'vitest';

// round 3 回归（用户报「bot 的反 ad 实际并没有工作」）。
//
// `noteInbound` 是反广告**唯一**的数据写入方，而它原来只在
// `pipeline/pipeline.ts:201`（legacy 的 processPipeline）。生产人类消息在
// `bot/handlers/message.ts:280` 就分来 Meta，永不进 processPipeline。
// 结果：授权键写了、读者每回合跑、**账本里一条数据都没有** →
// `[噪声]` 永远空 → 模型看不到刷屏。
//
// Redis 实测：两个授权群名下的 win: 键一条都没有；
// 仅有的两条属于另外两个群，是走 legacy 的 2% 留下的。
//
// 这三个性质必须锁住：
//   ① 授权的群 → 真的调 noteInbound（带 chatId/uid/text/秒级时间戳）
//   ② 没授权的群 → 不调（授权是前提，不能给所有群记账）
//   ③ 任何异常都不冒泡（采集失败不能带走整条 Meta 链路）

const noteInbound = vi.fn(async () => {});
const antiAdEnabled = vi.fn(async () => false);
let chatIds: number[] = [];

vi.mock('../../../src/nyatos/ad-pressure.js', () => ({
  noteInbound: (...a: unknown[]) => noteInbound(...a),
  antiAdEnabled: (...a: unknown[]) => antiAdEnabled(...a),
}));
vi.mock('../../../src/env.js', () => ({
  env: () => ({ ANTIAD_CHAT_IDS: chatIds }),
}));

/** 与 src/meta/ingress-intercepts.ts 里那段采集保持同形（改那边要同步这里）。 */
async function collect(chatId: number, uid: number, text: string, isBot = false): Promise<void> {
  if (chatId < 0 && !isBot) {
    const granted = (chatIds.includes(chatId)) || await antiAdEnabled(chatId);
    if (granted) await noteInbound(chatId, uid, text, Math.floor(Date.now() / 1000));
  }
}

describe('Meta 路径的反广告采集', () => {
  beforeEach(() => { noteInbound.mockClear(); antiAdEnabled.mockClear(); chatIds = []; antiAdEnabled.mockResolvedValue(false); });

  it('① env 灰名单命中的群 → 真的记账', async () => {
    chatIds = [-100111];
    await collect(-100111, 42, '刷屏内容');
    expect(noteInbound).toHaveBeenCalledWith(-100111, 42, '刷屏内容', expect.any(Number));
  });

  it('①b Redis per-chat 键授权的群 → 也记', async () => {
    antiAdEnabled.mockResolvedValue(true);
    await collect(-100222, 42, '刷屏内容');
    expect(noteInbound).toHaveBeenCalled();
  });

  it('② 没授权的群 → 不记（授权是前提）', async () => {
    await collect(-100333, 42, '普通聊天');
    expect(noteInbound).not.toHaveBeenCalled();
  });

  it('②b 别的 bot 的消息 → 不记（那是 denoise 的活）', async () => {
    chatIds = [-100111];
    await collect(-100111, 42, 'bot 的话', true);
    expect(noteInbound).not.toHaveBeenCalled();
  });

  it('③ 私聊不记（反广告是群级概念）', async () => {
    chatIds = [-100111];
    await collect(12345, 42, '私聊');
    expect(noteInbound).not.toHaveBeenCalled();
  });
});
