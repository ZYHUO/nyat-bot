import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AILabel } from '../../../src/ai/types.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────
//
// 这份测试存在的理由：2026-09-21 一次审计发现 art.draw 在生产里 **0% 成功**
// （2 次尝试 0 次送达），而 414 个单测文件全绿——因为 artist 的测试把
// callWithFallback mock 掉了，从来没人问过"这个 usage 到底解析不解析得出来"。
//
// 病因是 .env 在清 label 时删掉了 `AI_USAGE_ARTIST_LABEL=kimi` 整行，只留下
// BACKUPS/TIMEOUT/MAX_TOKENS/TEMPERATURE 四条孤儿键；env.ts:350 对"没有 LABEL
// 的 usage 组"直接 continue，USAGE_DEFAULTS 里又没有 artist —— 于是
// `getUsage('artist')` 每次都抛 AI usage not found: artist。
//
// 所以这里测的是**路由本身**：链解析得出来、链上 label 都真实存在、链不是
// "一荣俱荣一损俱损"的同一个模型。

const providerLabels = new Map<string, AILabel>();

vi.mock('../../../src/env.js', () => ({
  env: () => ({
    ARTIST_USAGE: 'artist',
    HEDGE_DELAY_MS: 0,
  }),
  // .env 的 artist 组**没有 LABEL**（这正是事故的形状）→ env 级路由里没有它，
  // getUsage 必须落到 labels.ts 的硬默认，而不是抛"usage not found"。
  getProviders: () => providerLabels,
  getUsageRouting: () => new Map(),
}));

// Must import AFTER mocks
const { getUsage, getLabels, _resetLabels } = await import('../../../src/ai/labels.js');

function label(name: string, model: string, tier: AILabel['tier'], endpoint: string): AILabel {
  return { name, endpoint, apiKeys: [`key-${name}`], model, apiFormat: 'claude', tier };
}

/** 生产池子的形状（.env 里 8 个 provider）——同名不同 key，用来验去重/同模型陷阱。 */
const POOL: AILabel[] = [
  label('stepfun', 'step-3.7-flash', 'high', 'https://api.stepfun.com/step_plan/v1'),
  label('stepfunvision', 'step-3.7-flash', 'medium', 'https://api.stepfun.com/step_plan/v1'),
  label('stepfunjudge', 'step-3.7-flash', 'medium', 'https://api.stepfun.com/step_plan/v1'),
  label('stepfunthink', 'step-3.5-flash', 'high', 'https://api.stepfun.com/step_plan/v1'),
  label('stepfunasi', 'step-3.7-flash', 'medium', 'https://api.stepfun.com/step_plan/v1'),
  label('dshkimi', 'kimi-for-coding', 'high', 'https://kimi.example/v1'),
  label('lfree', 'big-pickle', 'low', 'https://lfree.example/v1'),
  label('step5', 'step-5-preview', 'high', 'https://step5.example/v1'),
];

describe('artist（画摊子）的 AI 路由', () => {
  beforeEach(() => {
    providerLabels.clear();
    for (const l of POOL) providerLabels.set(l.name, l);
    _resetLabels();
  });

  it('getUsage("artist") 解析得出链——不再 "AI usage not found: artist"', () => {
    const u = getUsage('artist');
    expect(u.label).toBe('dshkimi');
    expect([u.label, ...u.backups].length).toBeGreaterThanOrEqual(2);
  });

  it('链上每个 label 都真实存在于 provider 池（不是被删掉的 kimi）', () => {
    const u = getUsage('artist');
    const known = getLabels();
    for (const n of [u.label, ...u.backups]) {
      expect(known.has(n), `${n} 不在 provider 池里`).toBe(true);
    }
  });

  it('链不是全同一个模型——一个熔断不该全灭（step-3.7-flash 五连坐陷阱）', () => {
    const u = getUsage('artist');
    const models = new Set([u.label, ...u.backups].map((n) => getLabels().get(n)!.model));
    expect(models.size).toBeGreaterThan(1);
  });

  it('timeout 撑得住一张精心 SVG（实测 kimi-for-coding 69s，35s 必砍）', () => {
    expect(getUsage('artist').timeout).toBeGreaterThanOrEqual(60_000);
  });
});
