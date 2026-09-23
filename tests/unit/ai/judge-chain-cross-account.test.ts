import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * judge 链必须有跨账号兜底（round 80）。
 *
 * 2026-09-23。09:30 后 51 次 `heart LLM failed`，57% 是
 * `All labels exhausted (all candidates cooling down)`。
 *
 * 根因：`AI_USAGE_JUDGE_BACKUPS=stepfunjudge`，而 `.env` 自己的注释
 * （STEPFUN_SEARCH_BASE_URL 那段）写着：
 *
 *   同一个账号下其余五个 label（STEPFUN/STEPFUNVISION/
 *   STEPFUNJUDGE/STEPFUNTHINK/STEPFUNASI）用的都是带这个路径的 base。
 *
 * 所以 judge 链 = **一个账号的两个 label**。主 label 被限流时，
 * backup 在同一个账号的限流窗口里 → 一起冷却 → 全灭。
 *
 * 这和 round 78 是同一个病（deep-reflection 和心流共用账号），
 * 但这次更隐蔽：**backup 看起来存在，实际不提供任何隔离**。
 * 我 round 79 还以为链是"stepfunasi, dshkimi, lfree"——那是记忆里的旧值。
 */
describe('judge 链的跨账号兜底', () => {
  /** 同一个 stepfun 账号下的 label（.env 注释列的五个 + 主）。 */
  const STEPFUN_FAMILY = new Set([
    'stepfun', 'stepfunvision', 'stepfunjudge', 'stepfunthink', 'stepfunasi',
  ]);

  it('① backups 里至少有一个 stepfun 家族外的 label', () => {
    const env = fs.readFileSync('.env', 'utf8');
    const backups = (env.match(/^AI_USAGE_JUDGE_BACKUPS=(.+)$/m)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(backups.length, 'judge 没有 backup').toBeGreaterThan(0);
    const crossAccount = backups.filter((b) => !STEPFUN_FAMILY.has(b));
    expect(crossAccount.length, `backups 全在 stepfun 账号内: ${backups.join(',')}`).toBeGreaterThan(0);
  });

  it('② 同账号 backup 保留（快，无额外握手）', () => {
    const env = fs.readFileSync('.env', 'utf8');
    const backups = (env.match(/^AI_USAGE_JUDGE_BACKUPS=(.+)$/m)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim());
    expect(backups).toContain('stepfunjudge');
  });

  it('③ 跨账号的那个排在同账号之后（顺序即优先级）', () => {
    const env = fs.readFileSync('.env', 'utf8');
    const backups = (env.match(/^AI_USAGE_JUDGE_BACKUPS=(.+)$/m)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim());
    const sameIdx = backups.indexOf('stepfunjudge');
    const crossIdx = backups.findIndex((b) => !STEPFUN_FAMILY.has(b));
    expect(sameIdx).toBeLessThan(crossIdx);
  });

  it('④ 跨账号 backup 自己有 KEY + MODEL（不然等于没有）', () => {
    const env = fs.readFileSync('.env', 'utf8');
    const backups = (env.match(/^AI_USAGE_JUDGE_BACKUPS=(.+)$/m)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim());
    const cross = backups.find((b) => !STEPFUN_FAMILY.has(b))!;
    const up = cross.toUpperCase();
    expect(env, `${up}_KEY 未配`).toMatch(new RegExp('^AI_PROVIDER_' + up + '_KEY=\\S+', 'm'));
    expect(env, `${up}_MODEL 未配`).toMatch(new RegExp('^AI_PROVIDER_' + up + '_MODEL=\\S+', 'm'));
  });

  it('⑤ .env.example 写清了同账号 backup 不提供隔离', () => {
    const ex = fs.readFileSync('.env.example', 'utf8');
    expect(ex).toMatch(/AI_USAGE_JUDGE_BACKUPS=/);
  });
});
