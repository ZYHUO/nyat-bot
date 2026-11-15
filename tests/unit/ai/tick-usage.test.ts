/**
 * tick 是独立的 AI usage，主 label 不能是回复链共用的 spacebunny。
 *
 * 为什么锁这个：统一唤醒 tick 原来用 judge，而 judge/reply/reply_pro/summarize/deep_think/asi 的
 * 主 label 都是 spacebunny，在飞上限 2 → 每 5 分钟那一刻坑被占满，797 次里 794 次 llm_failed。
 * 这里锁三件事：① tick 解析得出来 ② 它的链上没有任何回复链在用的主 label ③ unified-tick 默认就用它。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type { AILabel } from '../../../src/ai/types.js';

const providerLabels = new Map<string, AILabel>();
vi.mock('../../../src/env.js', () => ({
  env: () => ({ HEDGE_DELAY_MS: 0 }),
  getProviders: () => providerLabels,
  getUsageRouting: () => new Map(),
}));

const { getUsage, _resetLabels } = await import('../../../src/ai/labels.js');

function label(name: string, model: string): AILabel {
  return { name, endpoint: 'https://x.example/v1', apiKeys: ['k'], model, apiFormat: 'claude', tier: 'medium' };
}

beforeEach(() => {
  providerLabels.clear();
  for (const l of [label('spacebunny', 'space-bunny'), label('lfree', 'big-pickle'), label('mimo', 'mimo-v2.6-flash'), label('step5', 'step-5-preview')]) {
    providerLabels.set(l.name, l);
  }
  _resetLabels();
});

describe('tick usage', () => {
  it('① 解析得出来，主 label 是 mimo', () => {
    const u = getUsage('tick');
    expect(u.label).toBe('mimo');
    expect(u.timeout).toBeGreaterThanOrEqual(30_000);
  });

  it('② 生产 .env 里：tick 的 label 不出现在任何其它 usage 的主 label 或备份链上（否则又抢同一个在飞坑）', () => {
    // 第一版指向 lfree，上线后仍 llm_failed：lfree 是 reflection 的主 label，又是 reply/judge/
    // summarize/asi/deep_think 的备份——judge 一被挡就整批 fallback 到它，坑照样被抢光。
    // 所以判据不是"和主 label 不同"，而是"根本不在任何链上"。
    // 读生产 .env 的真实路由，而不是硬默认——硬默认指向早已删掉的 label，比出来没有意义。
    if (!existsSync('.env')) return;   // 没有 .env 的环境（新机器/CI）：无从比较
    const env = readFileSync('.env', 'utf8');
    const tickChain = [getUsage('tick').label, ...getUsage('tick').backups];
    const offenders: string[] = [];
    for (const m of env.matchAll(/^AI_USAGE_([A-Z0-9_]+?)_(LABEL|BACKUPS)=(.+)$/gm)) {
      const usage = m[1]!;
      if (usage === 'TICK') continue;
      const labels = m[3]!.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      for (const l of labels) if (tickChain.includes(l)) offenders.push(`${usage}_${m[2]} 含 ${l}`);
    }
    expect(offenders, `tick 的 label 被别的 usage 链引用：${offenders.join('；')}`).toEqual([]);
  });

  it('③ unified-tick 的默认 usage 就是 tick，且决策调用声明了 waitIfCooling', () => {
    const sec = readFileSync('src/env-sections/self.ts', 'utf8');
    expect(sec).toMatch(/UNIFIED_TICK_USAGE:\s*z\.string\(\)\.default\('tick'\)/);
    const src = readFileSync('src/cron/unified-tick.ts', 'utf8');
    expect(src.slice(src.indexOf('usage: env().UNIFIED_TICK_USAGE')).slice(0, 1200)).toContain('waitIfCooling: true');
  });

  it('④ tick 失败要在 info 以上可见（debug 级会让 llm_failed 的真实原因在 LOG_LEVEL=info 下消失）', () => {
    const src = readFileSync('src/cron/unified-tick.ts', 'utf8');
    const i = src.indexOf("'decideTick failed (fail-quiet)'");
    expect(i).toBeGreaterThan(0);
    // 往回找这条日志的调用名：必须是 warn/error，不是 debug
    const head = src.slice(Math.max(0, i - 220), i);
    expect(head).toMatch(/logger\.(warn|error)\(/);
    expect(head).not.toMatch(/logger\.debug\(/);
  });

  it('⑤ decideTick 的外壳超时 < tick usage 的底层 timeout，且不紧于线上实测的平均延迟（18.7s）', () => {
    const src = readFileSync('src/cron/unified-tick.ts', 'utf8');
    const m = src.match(/const TICK_RACE_TIMEOUT_MS = ([0-9_]+);/);
    expect(m, 'TICK_RACE_TIMEOUT_MS 不见了').not.toBeNull();
    const race = Number(m![1]!.replace(/_/g, ''));
    expect(race).toBeLessThan(getUsage('tick').timeout!);   // 外壳先到会把底层请求甩在飞坑里
    expect(race).toBeGreaterThanOrEqual(30_000);            // 25s 时 36 次里 10 次 tick_timeout
    expect(src).toContain('rej(new Error(\'tick_timeout\')), TICK_RACE_TIMEOUT_MS)');
  });
});
