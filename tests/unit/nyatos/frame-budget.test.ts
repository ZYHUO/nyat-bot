import { describe, expect, it } from 'vitest';
import { renderFrame } from '../../../src/nyatos/frame.js';
import { getBotUid } from '../../../src/bot/bot.js';
import { buildFrame } from '../../../src/nyatos/frame.js';

// room-awareness.ts:102 用 maxChars: 1200 渲染（默认 4000），而截断是
// `body.slice(0, maxChars)`——**从尾部砍**。身体事实行排在上下文之前，
// 所以我加的行不会丢；但每一行都在挤压上下文的位置。
// 这个测试量化挤压程度：我的新增行占了 1200 预算的多少。
describe('frame budget: 身体事实 vs 上下文的挤压', () => {
  it('身体事实行总长可测，且不挤掉上下文的主体', async () => {
    const botUid = getBotUid();
    const recent = Array.from({ length: 8 }, (_, i) => ({
      messageId: 1000 + i,
      chatId: -1004449419602,
      uid: 555000 + i,
      username: 'u' + i,
      fullName: '用户' + i,
      textContent: '这是一条测试消息，用来占据上下文长度，长度大约二十个字符左右。',
      timestamp: Math.floor(Date.now() / 1000) - 600 + i * 60,
      role: 'user',
      replyTo: undefined,
      isForwarded: false,
      visibility: 'public',
      sourceChatId: -1004449419602,
    })) as never[];

    const f = await buildFrame({
      scope: { visibility: 'chat', chatId: -1004449419602 },
      trigger: { messageId: 1 } as never,
      recent,
      botUid,
      withImpulses: true,
    });

    // 有身体事实的版本
    f.self.selfState = '[你自已] 这半小时你说得不少。';
    f.self.debt = '[欠话] 你睡着的时候 小美（欠 2 句）——总共欠 3 句。';
    f.self.echo = '[回声] 你最近说话，接的人不多——但这不代表不该说。';
    f.self.recentImpulses = [{ minutesAgo: 3, verdict: 'speak', why: '看到有人问签到的事，想凑上去' }];
    const withBody = renderFrame(f, { maxMessages: 8, maxChars: 1200 });

    // 同样的 frame 去掉身体事实
    const g = await buildFrame({
      scope: { visibility: 'chat', chatId: -1004449419602 },
      trigger: { messageId: 1 } as never,
      recent,
      botUid,
      withImpulses: false,
    });
    const withoutBody = renderFrame(g, { maxMessages: 8, maxChars: 1200 });

    // 实测（2026-09-19）：身体事实占 115/1200 ≈ 10%，且排在上下文**之前**，
    // 而截断是 slice(0, maxChars) 从尾部砍——所以身体事实永远不会被截掉，
    // 代价是上下文少 115 字。这个数要盯：若身体事实行长到吃掉三成预算，
    // 就该考虑给 CodeAct 路径单独放宽 maxChars。
    expect(withBody.length - withoutBody.length).toBeLessThan(400);

    // 关键断言：加满身体事实之后，上下文仍然在（没被截掉）
    expect(withBody.length).toBeGreaterThan(200);
    expect(withBody).toContain('[你自已]');
    expect(withBody).toContain('[欠话]');
    expect(withBody).toContain('[回声]');
    // 上下文主体仍在（8 条里至少还有几条）
    expect(withBody).toContain('用户0');
  });
});
