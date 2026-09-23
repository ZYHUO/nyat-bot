import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * 对端把命令退回时不能当成查询结果（round 168，计划第 1 步）。
 *
 * 2026-09-23 15:05 现场：代发 /geo 无参数 → 对端回
 * "Please provide an IP or domain / Usage: /geo IP_or_domain"
 * → 旧代码把它当结果，按"结果用不上或为空就说没查到"的指示解了一句
 *   "没查到相关数据喵"。
 *
 * 这是第三种回执（不是占位、不是结果、不是空消息），必须单独一支。
 */
describe('代发回执：命令被退回', () => {
  const SRC = 'src/pipeline/tools/bot-delegation.ts';

  it('① 有 isCommandRejection，且是 isProgressPlaceholder 的兄弟函数', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const code = s.split('\n').filter((l) => !l.trimStart().startsWith('//'));
    expect(code.some((l) => l.includes('function isCommandRejection('))).toBe(true);
    expect(code.some((l) => l.includes('function isProgressPlaceholder('))).toBe(true);
  });

  it('② 退回分支在占位之后、结果之前（顺序错就会漏）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const ph = s.indexOf('isProgressPlaceholder(resultText)');
    const rej = s.indexOf('isCommandRejection(resultText)');
    const consume = s.indexOf('命中最终结果');
    expect(ph).toBeGreaterThan(-1);
    expect(rej).toBeGreaterThan(ph);
    expect(consume).toBeGreaterThan(rej);
  });

  it('③ 退回时清 pending（不清的话下一条群消息会被当成它的结果）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('isCommandRejection(resultText)');
    const after = s.slice(i, i + 700);
    expect(after).toContain('redis.del(PENDING_KEY(chatId))');
  });

  it('④ 有计数器 + info 日志（round 75 家族：跳过也要可观测）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    const i = s.indexOf('isCommandRejection(resultText)');
    const after = s.slice(i, i + 700);
    expect(after).toContain('delegation_receipt_usage_error_total');
    expect(after).toContain('logger.info');
    expect(after).toContain('usage error, not a result');
  });

  it('⑤ 退回有自己的指示文案，明确"别当数据、别说没查到、别编参数"', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('[代发被退回]');
    expect(s).toContain('这不是查询结果');
    expect(s).toContain('没查到相关数据');
    expect(s).toContain('绝对不要自己编一个参数再发一次');
  });

  it('⑥ answerFromDelegation 用 rejected 参数分流（不是复制一整份函数）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).toContain('rejected = false,');
    expect(s).toContain('const userMsg = rejected');
    // 原来的"结果"指示必须还在（退回是新增分支，不是替换）
    expect(s).toContain('[代发结果]');
  });

  it('⑦ 没有把 unicode 转义写进源码（round 119/154 的规矩）', () => {
    const s = fs.readFileSync(SRC, 'utf8');
    expect(s).not.toContain('\\u2014');
    expect(s).not.toContain('\\u4e0d');
  });
});
