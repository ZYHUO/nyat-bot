/**
 * Meta 主路径必须做 bot 分类 + 降噪。
 *
 * 缺口：botClass 只在 processPipeline 里算，而生产主路径
 * （META_SUBAGENT_ENABLED 开着）从 message.ts 直接分流到 heart-adapter，
 * 根本不进 processPipeline —— 于是 nmnmfunbot（入群验证 bot）的消息
 * 照常拿 heart 判定并被回复（实测 6 次，含 2026-09-20 04:55）。
 *
 * 这里锁的是"分类器在 Meta 路径上被调用且 verify/ad/echo 被降噪"。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 直接测分类器对验证 bot 的真实输出（不 mock 分类逻辑——那正是要保住的）
const { classifyBotMessage } = await import('../../../src/tracking/bot-classifier.js');

const VERIFY_TEXT = '入群验证  欢迎 Z***g ⭐️ 加入群组！请完成入群验证。 请点击“加入频道”按钮加入频道后点击“完成验证”按钮验证。  请在 2 分钟内完成验证以免被永久封禁。';

describe('Meta 路径的 bot 降噪（验证 bot 搭配）', () => {
  it('nmnmfunbot 的验证消息被分为 verify', () => {
    const bc = classifyBotMessage({
      isBot: true,
      uid: 5304501737,
      username: 'nmnmfunbot',
      fullName: 'nmnmfunbot',
      textContent: VERIFY_TEXT,
    } as never, {});
    expect(bc).toBe('verify');
  });

  it('verify 的建议动作是 ignore（不是 interact）', async () => {
    const { suggestedBotAction } = await import('../../../src/tracking/bot-classifier.js');
    expect(suggestedBotAction('verify')).toBe('ignore');
  });

  it('真人的正常消息不是 verify', () => {
    const bc = classifyBotMessage({
      isBot: false, uid: 8560347478, username: 'someone', fullName: '某人',
      textContent: '今天天气不错啊喵',
    } as never, {});
    expect(bc).toBe('unknown');
  });

  it('**suggestedBotAction 必须有调用方**（它曾经零调用方）', async () => {
    // 这条是防回归：分类器给出判定而没人执行，正是这次缺口的形状。
    //
    // 2026-09-21：两道闸从 message.ts 抽到了 meta-bot-gate.ts（内联在闭包里
    // 没有任何测试能碰到，正是那个缺口能存在的原因）。所以这里改成：
    //   ① 判据在 gate 文件里
    //   ② message.ts 必须真的调用那个 gate
    // 只查其中一边都会漏——判据在但没人调，就是"写了没接"。
    const { readFileSync } = await import('node:fs');
    const gate = readFileSync('src/bot/handlers/meta-bot-gate.ts', 'utf8');
    const src = readFileSync('src/bot/handlers/message.ts', 'utf8');
    // 判据：非对话型 bot 三类
    expect(gate).toContain("NON_CONVERSATIONAL");
    for (const cls of ['ad', 'verify', 'echo']) expect(gate).toContain(`'${cls}'`);
    // 接线：message.ts 必须调用 gate，并且把分类器喂给它
    // （gate 是依赖注入——分类器以参数形式传入，这是它可单测的原因；
    //   所以"调用分类器"这件事要看 message.ts，不看 gate 文件）
    expect(src).toContain('decideBotMessage');
    expect(src).toContain('classifyBotMessage');
    // gate 侧：声明了 classify 参数并且真的调用它（不是收下不用）
    expect(gate).toMatch(/classify:\s*\(m: FormattedMessage\) => string/);
    expect(gate).toContain('const cls = classify(fm)');
  });
});
