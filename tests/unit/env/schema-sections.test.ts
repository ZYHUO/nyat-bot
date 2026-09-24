/**
 * env schema 拆段的守卫。
 *
 * 2026-09-21 把 `src/env.ts` 里 1436 行的 schema 体按子系统拆成
 * `src/env-sections/*.ts`（12 个段），`src/env.ts` 只用 spread 合回去。
 * 动机：489 个键堆在一个文件里，加一个旗标要翻整篇。
 *
 * 拆段是纯机械搬迁，但"机械"两个字正是风险所在——切错一行、漏一段、
 * 或者两段里出现同名键（后者会被 spread 静默后者覆盖前者），都不会报错。
 * 这个测试钉住三件事：
 *
 *   ① 段文件里的键集合与拆分前完全一致（一个不少、一个不多、无重复）
 *   ② `env()` 真能 parse（组合没把 schema 弄坏）
 *   ③ 每个段文件都被 env.ts import 了（加了文件忘了接 = 那一整段静默消失）
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SECTION_DIR = 'src/env-sections';

function sectionFiles(): string[] {
  return readdirSync(SECTION_DIR)
    .filter((f) => f.endsWith('.ts') && f !== '_shared.ts')
    .map((f) => join(SECTION_DIR, f));
}

/** 段文件里 `export const xxxSection = { ... }` 之后的顶层键。 */
function keysIn(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf('Section = {');
  expect(start, `${file} 里找不到 "Section = {"`).toBeGreaterThan(-1);
  const body = text.slice(start);
  return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
}

describe('env schema 拆段', () => {
  it('① 键集合：无丢失、无新增、跨段无重复', () => {
    const seen = new Map<string, string>();
    const all: string[] = [];
    for (const f of sectionFiles()) {
      for (const k of keysIn(f)) {
        expect(seen.has(k), `键 ${k} 在 ${f} 和 ${seen.get(k)} 里重复定义（spread 会静默覆盖）`).toBe(false);
        seen.set(k, f);
        all.push(k);
      }
    }
    // 497 = 488 + 8（JEV_*，新增 src/env-sections/ai.ts 段）
    //       + 1（AI_MAX_INFLIGHT_PER_MODEL，round 198 的在飞上限）。
    // 加旗标时这个数会变——
    // 那时该做的是重新核对，而不是把这个数字改大。
    // round 206: 497 → 498（加了 SEND_LOG_FULL_TEXT）
    expect(all.length).toBe(498);
    expect(new Set(all).size).toBe(498);
    // 键名必须是合法 env 变量名（否则 .env 里设了也读不到）
    for (const k of all) expect(k).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it('② 组合后的 schema 还能 parse（拆段没把 zod 对象弄坏）', async () => {
    const { parseEnv } = await import('../../../src/env.js');
    const parsed = parseEnv({ BOT_TOKEN: 'x', REDIS_URL: 'redis://127.0.0.1:6379/5' });
    // 抽几个不同段里的键，确认它们都还在且默认值没丢
    expect(parsed.BOT_TOKEN).toBe('x');                        // infra
    expect(parsed.TIMING_GATE_MAX_TOKENS).toBe(4000);          // timing (round 70: 1200 被思维链吃光)
    expect(parsed.CORE_V2_ENABLED).toBe(true);                 // core
    expect(parsed.AGENT_TASK_SEND_BUDGET).toBe(6);             // meta
    expect(parsed.VIDEO_DESCRIBE_ENABLED).toBe(true);          // features
    expect(parsed.NYATOS_BUDGET_MAX_ACTS).toBe(6);             // life
  });

  it('③ 每个段文件都被 env.ts import（加了文件忘了接 = 整段静默消失）', () => {
    const src = readFileSync('src/env.ts', 'utf8');
    for (const f of sectionFiles()) {
      const name = f.split('/').pop()!.replace('.ts', '');
      expect(src, `env.ts 没有 import ${name}Section`).toContain(`from './env-sections/${name}.js'`);
      expect(src, `env.ts 没有 spread ${name}Section`).toContain(`...${name}Section,`);
    }
  });

  it('③b booleanFromEnv 只有一份定义（12 个段共用，别复制）', () => {
    const shared = readFileSync(join(SECTION_DIR, '_shared.ts'), 'utf8');
    expect(shared).toContain('export const booleanFromEnv');
    for (const f of sectionFiles()) {
      const text = readFileSync(f, 'utf8');
      expect(text, `${f} 自己又定义了一份 booleanFromEnv`).not.toContain('const booleanFromEnv =');
      expect(text).toContain("from './_shared.js'");
    }
    // env.ts 本体也不该再有一份
    expect(readFileSync('src/env.ts', 'utf8')).not.toContain('booleanFromEnv = z.preprocess');
  });
});
