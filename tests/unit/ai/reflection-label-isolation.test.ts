import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';

/**
 * deep-reflection 不该和心流抢同一个账号（round 78）。
 *
 * 2026-09-23。巡检发现 `deep-reflection: LLM failed` 869 次，err 全是
 * `All labels exhausted (all candidates cooling down)`。而它已经
 * `waitIfCooling: true` + `maxTimeoutMs: 20000` + 串行 for-await——
 * 自己的并发度是对的。
 *
 * 根因在账号容量：`AI_USAGE_REFLECTION_LABEL=stepfun`，和心流
 * （`AI_USAGE_JUDGE_LABEL=stepfun`）**同一个账号**。近 1 小时实测：
 *
 *   Heart decision 179 · CodeAct task 71 · reflection tick 6
 *   → 约 250 次/小时 = 4 次/分钟
 *
 * 而 .env 自己的注释写着 stepfun "账号 RPM≈10 勿当热路径主选"，
 * provider 侧的并发上限比 RPM 更严（`concurrent request limit` 3144 次）。
 *
 * round 72 把 `REASONING_TOKEN_FLOOR` 从 1200 抬到 4000 让每个请求
 * 占用更久 → 并发窗口内堆积更多 → 更容易撞上限。**这是我的副作用**，
 * 但根因是"后台批任务和热路径共用一个账号"。
 *
 * 这条测试锁住：reflection 的 label 不能和 judge（心流）相同。
 * 后台任务和热路径抢同一条熔断链，结果是热路径把后台饿死。
 */
describe('reflection 与 judge 的账号隔离', () => {
  it('① reflection 的 label 不等于 judge 的 label', () => {
    const env = fs.readFileSync('.env', 'utf8');
    const get = (k: string) => env.match(new RegExp('^' + k + '=(.+)$', 'm'))?.[1]?.trim();
    const refl = get('AI_USAGE_REFLECTION_LABEL');
    const judge = get('AI_USAGE_JUDGE_LABEL');
    expect(refl, 'AI_USAGE_REFLECTION_LABEL 未配置').toBeTruthy();
    expect(judge, 'AI_USAGE_JUDGE_LABEL 未配置').toBeTruthy();
    expect(refl).not.toBe(judge);
  });

  it('② 隔离写进了 .env.example（.env gitignored，示例要能复现）', () => {
    const ex = fs.readFileSync('.env.example', 'utf8');
    expect(ex).toMatch(/AI_USAGE_REFLECTION_LABEL=/);
  });

  it('③ 代码侧已经做了它能做的（等冷却 + 超时 + 串行）', () => {
    // 这条锁住"别把账号问题推给代码"：代码三件套都在，
    // 剩下的只能靠配置隔离。
    const s = fs.readFileSync('src/cron/deep-reflection.ts', 'utf8');
    expect(s).toContain('waitIfCooling: true');
    expect(s).toContain('for (const chatId of chatIds) {');   // 串行，不是 Promise.all
    expect(s).toContain('const r = await reflectChat(chatId)');
  });
});
