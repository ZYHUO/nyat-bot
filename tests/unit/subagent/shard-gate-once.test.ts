import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 同一次 sendText 的分片只过一次闸（round 71）。
 *
 * 2026-09-23。round 68 把 NYATOS_BUDGET_MIN_GAP_ADDRESSED_SEC 从 30 改成 8，
 * 解决"整条被吞"（49%）。但漏了"分片被吞"（35%）：
 *
 *   第 1 片发出 → markActiveSpeech 写 lastact
 *   →（打字延迟）
 *   → 第 2 片到达 → 已超 8s → 被咽
 *
 * 群里看到的就是半句话。round 70 部署后实测 07:14-07:15 仍有
 * part=2/3、part=2/2 被咽，正是这条。
 *
 * 而分片是**同一句话的多个气泡**，不是两次发言。闸的本意是分隔"两次开口"
 * （"5 秒内连回三个人"那种机器形状），拿它切自己的一句话是误用。
 */
describe('分片共享一次过闸结果', () => {
  const SRC = 'src/subagent/host-api.ts';

  it('① 闸的条件带 !gatePassed（第 0 片过后后续片不再问）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toMatch(/if \(chatId < 0 && env\(\)\.TRENCH_GATE_ENABLED && !gatePassed\) \{/);
  });

  it('② gatePassed 在分片循环外声明（一次 sendText 一份）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    // 声明必须在 for 之前
    const declIdx = s.indexOf('let gatePassed = false;');
    const loopIdx = s.indexOf('for (let i = 0; i < parts.length; i++) {');
    expect(declIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeGreaterThan(declIdx);
  });

  it('③ 闸放过之后才置位（不是无条件置位）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    // 置位行必须在闸的闭合括号之后、sendMessage 之前
    const setIdx = s.indexOf('gatePassed = true;');
    const gateIdx = s.indexOf('!gatePassed');
    const sendIdx = s.indexOf('const messageId = await sendMessage(chatId, part, replyTo, opts.messageThreadId);');
    expect(gateIdx).toBeLessThan(setIdx);
    expect(setIdx).toBeLessThan(sendIdx);
  });

  it('④ 第 0 片被拦仍然抛（闸的本意没被削掉）', () => {
    // 判据没变：blockedByGate + throw 都在。只是后续片不再重复问。
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain("blockedByGate.push(why)");
    expect(s).toContain('连得太密了');          // 闸的文案还在
    expect(s).toContain('budget_spent');        // 三条理由都还在
  });
});
