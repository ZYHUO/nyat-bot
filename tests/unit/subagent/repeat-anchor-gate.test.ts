import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 同一锚点短时间内重复回复要拦（round 89）。
 *
 * 2026-09-23 抓到现行（用户："前言不搭后语 + 重复回复"）：
 * mid=13862 在 7 分钟内被回了 4 次（四句都不同，所以前缀去重挡不住）。
 *
 * Redis 里 answered 账本存着 5 个时间戳——`markMessageAnswered` 一直在记，
 * 但读者只有 Heart decision 的 prompt 注入（提示不是闸）；
 * 而那 5 次发送只有 1 次经过心流。
 *
 * 量化：近 6 小时 207 条带锚发送里 **12 组**是这种（5.8%）。
 */
describe('重复锚点闸', () => {
  const SRC = 'src/subagent/host-api.ts';

  it('① 有窗口和上限两个常量', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('const REPEAT_ANCHOR_WINDOW_SEC = 180;');
    expect(s).toContain('const REPEAT_ANCHOR_MAX = 2;');
  });

  it('② 读的是 answered 账本（不是自己另记一份）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('answeredTimestamps(chatId, firstReplyTo)');
  });

  it('③ 超过上限时 throw（不是静默丢）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('sendText: 同一锚点短时间内已回过');
    expect(s).toContain('抛');   // 注释里说明 throw 的理由
    // 抛的文案要能告诉模型"为什么没发出去"
    expect(s).toContain('连着回同一条会显得在刷屏');
  });

  it('④ 有计数器', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('send_repeat_anchor_total');
    expect(s).toContain('incrCounter');
  });

  it('⑤ 只查首气泡的锚点（后续分句不带引用，不构成"又回一次"）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('if (i === 0 && firstReplyTo && firstReplyTo > 0) {');
  });

  it('⑥ 窗口只有 3 分钟（隔很久再回同一条是合理的——有人追问）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('const REPEAT_ANCHOR_WINDOW_SEC = 180;');
    // 不能设成 7 天（answered 的 TTL）——那会把合理追问也拦掉
    expect(s).not.toContain('REPEAT_ANCHOR_WINDOW_SEC = 604800');
  });

  it('⑦ markMessageAnswered 仍在发送后跑（账本要继续记）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('markMessageAnswered(chatId, mid)');
  });

  it('⑧ 闸在 sendMessage 之前（round 89 修：第一版放在 textSent+=1 之后，消息已发出）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const gateIdx = s.indexOf('answeredTimestamps(chatId, firstReplyTo)');
    const sendIdx = s.indexOf('const messageId = await sendMessage(chatId, part, replyTo, opts.messageThreadId)');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(-1);
    expect(gateIdx, '闸必须在 sendMessage 之前').toBeLessThan(sendIdx);
  });

  it('⑨ 闸之后 markMessageAnswered 仍在（记账继续）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const gateIdx = s.indexOf('answeredTimestamps(chatId, firstReplyTo)');
    const markIdx = s.indexOf('markMessageAnswered(chatId, mid)');
    expect(gateIdx).toBeLessThan(markIdx);
  });

  it('⑩ 只查首气泡（i === 0）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('if (i === 0 && firstReplyTo && firstReplyTo > 0) {');
  });
});
