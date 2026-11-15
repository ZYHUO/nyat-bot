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
import { basename, join } from 'node:path';
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
    // 2026-10-01: 498 → 499（META_INJECT_LEARNED_ENABLED，把学习产物接进 Meta 路径）
    //             499 → 501（GOAL_CLOSE_OBSERVE_ENABLED / GOAL_CLOSE_OBSERVE_HOURS，goal 待关闭观察期）
    //             501 → 502（CODEACT_WEB_FETCH_TO_FILE_ENABLED，沙盒无网络，宿主侧带数据进来）
    // Includes this rollout's transport/runtime settings; independently recounted.
    // Independently recounted after QQ pre-Heart batching, addressing and display-name controls.
    // Recounted all section keys and verified uniqueness for this rollout.
    // DM_AUTO_PRIVATE retired: a flag cannot grant private-context disclosure.
    // Explicit opt-in binding for the two configured owner identities.
    // 2026-11-15: independently counted 546 schema keys across 13 sections,
    // including pending intent, life-project (two) and background publication.
    // Parsed default objects omit 19 optional keys and are not this denominator.
    // Five isolated video replica controls; standalone server settings are not bot keys.
    // Recounted 559 unique keys: two business settings gates and six release/readiness controls.
    expect(all.length).toBe(559);
    expect(new Set(all).size).toBe(559);
    // 键名必须是合法 env 变量名（否则 .env 里设了也读不到）
    for (const k of all) expect(k).toMatch(/^[A-Z][A-Z0-9_]+$/);
  });

  it('② 组合后的 schema 还能 parse（拆段没把 zod 对象弄坏）', async () => {
    const { parseEnv } = await import('../../../src/env.js');
    const parsed = parseEnv({ BOT_TOKEN: 'x', REDIS_URL: 'redis://127.0.0.1:6379/5' });
    // 抽几个不同段里的键，确认它们都还在且默认值没丢
    expect(parsed.BOT_TOKEN).toBe('x');                        // infra
    expect(parsed.BUSINESS_CONFIG_ENABLED).toBe(false);
    expect(parsed.BUSINESS_CONFIG_CHAT_IDS).toEqual([]);
    expect(parsed.READINESS_ENABLED).toBe(false);
    expect(parsed.NYAT_RELEASE_ID).toBe('');
    expect(parsed.UPDATE_REQUESTS_ENABLED).toBe(false);
    expect(parsed.UPDATE_CONTROL_CHAT_IDS).toEqual([]);
    expect(parsed.UPDATE_REQUEST_DIR).toBe('');
    expect(parsed.UPDATE_RESULT_DIR).toBe('');
    expect(parsed.TIMING_GATE_MAX_TOKENS).toBe(4000);          // timing (round 70: 1200 被思维链吃光)
    expect(parsed.CORE_V2_ENABLED).toBe(true);                 // core
    expect(parsed.AGENT_TASK_SEND_BUDGET).toBe(6);             // meta
    expect(parsed.VIDEO_DESCRIBE_ENABLED).toBe(true);          // features
    expect(parsed.VIDEO_REMOTE_ENABLED).toBe(false);
    expect(parsed.VIDEO_REMOTE_ENDPOINTS).toEqual([]);
    expect(parsed.VIDEO_REMOTE_TOKEN).toBe('');
    expect(parsed.VIDEO_REMOTE_DECODER_SHA256).toBe('');
    expect(parsed.VIDEO_REMOTE_TIMEOUT_MS).toBe(20_000);
    expect(parsed.NYATOS_BUDGET_MAX_ACTS).toBe(6);             // life
    expect(parsed.PROACTIVE_ACTIVATED_AT_SEC).toBe(0);         // cognition
    expect(parsed.META_ACTIVATED_AT_SEC).toBe(0);              // meta (disabled until explicitly activated)
    expect(parsed.META_DIRECT_COALESCE_MS).toBe(0);            // opt-in direct-message batching
    expect(parsed.META_DIRECT_COALESCE_MAX_MS).toBe(2000);
    expect(parsed.META_QQ_HEART_REFRACTORY_MS).toBe(0);
    expect(parsed.META_HEART_REFRACTORY_MS).toBe(45_000);
    expect(parsed.META_QQ_GROUP_COALESCE_MS).toBe(0);
    expect(parsed.META_QQ_GROUP_COALESCE_MAX_MS).toBe(4000);
    expect(parsed.META_QQ_MENTION_HEART_ENABLED).toBe(false);
    expect(parsed.ONEBOT_DISPLAY_NAME).toBe('');
    expect(parsed.ONEBOT_MEDIA_ENABLED).toBe(false);
    expect(parsed.ONEBOT_GROUP_FILE_SOURCE).toBe('message');
    expect(parsed.OWNER_MEMORY_LINK_ENABLED).toBe(false);
    expect(parsed.AUDIO_TRANSCRIBE_API_MODE).toBe('chat');     // infra compatibility default
    expect(parsed.TTS_PYTHON_PATH).toBe('python3');            // life
    expect(parsed.TTS_FFMPEG_PATH).toBe('ffmpeg');             // life
  });

  it('direct-burst windows parse explicit values and reject unbounded or invalid delays', async () => {
    const { parseEnv } = await import('../../../src/env.js');
    const required = { BOT_TOKEN: 'x', REDIS_URL: 'redis://127.0.0.1:6379/5' };
    const parsed = parseEnv({ ...required, META_DIRECT_COALESCE_MS: '800', META_DIRECT_COALESCE_MAX_MS: '2000' });
    expect(parsed.META_DIRECT_COALESCE_MS).toBe(800);
    expect(parsed.META_DIRECT_COALESCE_MAX_MS).toBe(2000);
    for (const value of ['-1', 'NaN', '30001']) {
      expect(() => parseEnv({ ...required, META_DIRECT_COALESCE_MS: value })).toThrow();
    }
    expect(() => parseEnv({ ...required, META_DIRECT_COALESCE_MAX_MS: '0' })).toThrow();
  });

  it('group files select exactly one representation, never an ambiguous both mode', async () => {
    const { parseEnv } = await import('../../../src/env.js');
    expect(parseEnv({ BOT_TOKEN: 'x', ONEBOT_GROUP_FILE_SOURCE: 'notice' }).ONEBOT_GROUP_FILE_SOURCE).toBe('notice');
    for (const value of ['both', '', 'auto']) expect(() => parseEnv({ BOT_TOKEN: 'x', ONEBOT_GROUP_FILE_SOURCE: value })).toThrow();
  });

  it('QQ cooldown is opt-in and does not change the Telegram default', async () => {
    const { parseEnv } = await import('../../../src/env.js');
    const parsed = parseEnv({ BOT_TOKEN: 'x', META_QQ_HEART_REFRACTORY_MS: '10000' });
    expect(parsed.META_QQ_HEART_REFRACTORY_MS).toBe(10_000);
    expect(parsed.META_HEART_REFRACTORY_MS).toBe(45_000);
    for (const value of ['-1', 'NaN', '1.5']) expect(() => parseEnv({ BOT_TOKEN: 'x', META_QQ_HEART_REFRACTORY_MS: value })).toThrow();
  });

  it('QQ pre-decision windows and addressed discretion parse explicit bounded settings', async () => {
    const { parseEnv } = await import('../../../src/env.js');
    const parsed = parseEnv({ BOT_TOKEN: 'x', META_QQ_GROUP_COALESCE_MS: '1500',
      META_QQ_GROUP_COALESCE_MAX_MS: '4000', META_QQ_MENTION_HEART_ENABLED: 'true' });
    expect(parsed.META_QQ_GROUP_COALESCE_MS).toBe(1500);
    expect(parsed.META_QQ_GROUP_COALESCE_MAX_MS).toBe(4000);
    expect(parsed.META_QQ_MENTION_HEART_ENABLED).toBe(true);
    for (const value of ['-1', 'NaN', '30001']) expect(() => parseEnv({ BOT_TOKEN: 'x', META_QQ_GROUP_COALESCE_MS: value })).toThrow();
    expect(() => parseEnv({ BOT_TOKEN: 'x', META_QQ_GROUP_COALESCE_MAX_MS: '0' })).toThrow();
  });

  it('③ 每个段文件都被 env.ts import（加了文件忘了接 = 整段静默消失）', () => {
    const src = readFileSync('src/env.ts', 'utf8');
    for (const f of sectionFiles()) {
      const name = basename(f, '.ts');
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
