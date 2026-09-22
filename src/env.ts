import { z } from 'zod';
import 'dotenv/config';

// booleanFromEnv 已移到 ./env-sections/_shared.ts（12 个段文件共用一份）。

import { infraSection } from './env-sections/infra.js';
import { memorySection } from './env-sections/memory.js';
import { timingSection } from './env-sections/timing.js';
import { judgeSection } from './env-sections/judge.js';
import { cognitionSection } from './env-sections/cognition.js';
import { coreSection } from './env-sections/core.js';
import { aiSection } from './env-sections/ai.js';
import { selfSection } from './env-sections/self.js';
import { turnSection } from './env-sections/turn.js';
import { metaSection } from './env-sections/meta.js';
import { featuresSection } from './env-sections/features.js';
import { socialSection } from './env-sections/social.js';
import { lifeSection } from './env-sections/life.js';

const envSchema = z.object({
  ...infraSection,
  ...memorySection,
  ...timingSection,
  ...judgeSection,
  ...cognitionSection,
  ...aiSection,
  ...coreSection,
  ...selfSection,
  ...turnSection,
  ...metaSection,
  ...featuresSection,
  ...socialSection,
  ...lifeSection,
});


export type Env = z.infer<typeof envSchema>;

export function parseEnv(overrides?: Record<string, string | undefined>): Env {
  const source = overrides ?? process.env;
  return envSchema.parse(source);
}

let _env: Env | undefined;

export function env(): Env {
  if (!_env) {
    _env = parseEnv();
  }
  return _env;
}

// ── AI Provider & Usage parsing from env ──────────────────

export interface EnvProvider {
  name: string;
  endpoint: string;
  apiKey: string;
  model: string;
  apiFormat?: 'openai' | 'claude';
  stream?: boolean;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  disableThinking?: boolean;
  insecureTLS?: boolean;
  /** 强制走 raw fetch 路径(而非 Vercel AI SDK generateText):裸路径对畸形/空响应用
   *  安全可选链、返空不崩;某些端点(如 gemini)偶尔返回空 choices 会把 SDK 崩成
   *  "reading 'message'" → 无谓回退。AI_PROVIDER_X_RAW=true 开。 */
  forceRaw?: boolean;
  /** per-provider 每次尝试超时(ms)覆盖 usage 超时;给慢模型(如 mundo)单独放宽用。 */
  timeout?: number;
  /** per-provider maxTokens 覆盖;给推理模型(如 mundo)单独放宽,防被小 maxTokens 截断成空。 */
  maxTokens?: number;
  /** per-provider temperature 强制覆盖(调用方显式值也让位):给只接受固定温度的模型
   *  (如 kimi-k3 只允许 temperature=1,否则 400 invalid temperature)。
   *
   *  round 12（新 goal）：`'omit'` = 这个 provider **不要传 temperature 字段**。
   *  dshkimi 实测：传 1 同 prompt 6 次翻 1 次，不传 6/6 一致。
   *  见 AIImage.temperature / AILabel.temperature 的注释。 */
  temperature?: number | 'omit';
  /** 声明是否支持图片输入(P2 多模态回复)。undefined=未知(照发,provider 自己拒);
   *  false=明确不支持(带图调用直接跳过该 label,不白烧一跳)。 */
  vision?: boolean;
  /** 声明是否支持 `video_url` content part(2026-09-21 视频理解)。
   *  **必须显式 true 才进 video usage 的候选池**——"返回 200"不等于"看得懂":
   *  实测 step-3.7-flash 收下 video_url 但 content 为空(token 全烧 reasoning 上)。
   *  没声明的一律不当视频供应商用,宁可按手动链走 step5。 */
  video?: boolean;
  /** Smart Group auto-assign 质量分层: high=主力回复模型, medium=中等(judge/summarize),
   *  low=廉价快模型(gate/cheap batch)。未声明默认 medium。 */
  tier?: 'high' | 'medium' | 'low';
}

export interface EnvUsage {
  label: string;
  backups: string[];
  timeout?: number;
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

let _providers: Map<string, EnvProvider> | undefined;
let _usages: Map<string, EnvUsage> | undefined;

function readBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === 'true';
}

function readNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function addProviderIfMissing(
  providers: Map<string, EnvProvider>,
  name: string,
  config: {
    endpoint?: string;
    apiKey?: string;
    model?: string;
    apiFormat?: 'openai' | 'claude';
    stream?: boolean;
  },
): void {
  if (providers.has(name) || !config.endpoint || !config.model) return;
  providers.set(name, {
    name,
    endpoint: config.endpoint,
    apiKey: config.apiKey ?? '',
    model: config.model,
    apiFormat: config.apiFormat,
    stream: config.stream,
  });
}

function buildLegacyProviders(source: NodeJS.ProcessEnv, providers: Map<string, EnvProvider>): void {
  const primaryEndpoint = source['AI_BASE_URL'];
  const primaryKey = source['AI_API_KEY'];

  addProviderIfMissing(providers, 'reply', {
    endpoint: primaryEndpoint,
    apiKey: primaryKey,
    model: source['AI_MODEL_REPLY'],
  });
  addProviderIfMissing(providers, 'vision', {
    endpoint: primaryEndpoint,
    apiKey: primaryKey,
    model: source['AI_MODEL_VISION'],
  });
  addProviderIfMissing(providers, 'judge', {
    endpoint: primaryEndpoint,
    apiKey: primaryKey,
    model: source['AI_MODEL_JUDGE'] ?? source['AI_MODEL_REPLY'],
  });
  addProviderIfMissing(providers, 'summarize', {
    endpoint: primaryEndpoint,
    apiKey: primaryKey,
    model: source['AI_MODEL_SUMMARIZE'] ?? source['AI_MODEL_REPLY'],
  });
  addProviderIfMissing(providers, 'allowlist_review', {
    endpoint: primaryEndpoint,
    apiKey: primaryKey,
    model: source['AI_MODEL_ALLOWLIST_REVIEW'] ?? source['AI_MODEL_REPLY'],
  });
  addProviderIfMissing(providers, 'path_reflection', {
    endpoint: primaryEndpoint,
    apiKey: primaryKey,
    model:
      source['AI_MODEL_PATH_REFLECTION']
      ?? source['AI_MODEL_JUDGE']
      ?? source['AI_MODEL_REPLY'],
  });
  addProviderIfMissing(providers, 'reply_splitter', {
    endpoint: primaryEndpoint,
    apiKey: primaryKey,
    model: source['AI_MODEL_REPLY_SPLITTER'] ?? source['AI_MODEL_REPLY'],
  });

  const localEndpoint = source['LOCAL_AI_BASE_URL'];
  const localKey = source['LOCAL_AI_API_KEY'];
  addProviderIfMissing(providers, 'local_judge', {
    endpoint: localEndpoint,
    apiKey: localKey,
    model: source['LOCAL_AI_MODEL_JUDGE'],
  });
  addProviderIfMissing(providers, 'local_summarize', {
    endpoint: localEndpoint,
    apiKey: localKey,
    model: source['LOCAL_AI_MODEL_SUMMARIZE'],
  });
  addProviderIfMissing(providers, 'local_allowlist_review', {
    endpoint: localEndpoint,
    apiKey: localKey,
    model: source['LOCAL_AI_MODEL_ALLOWLIST'] ?? source['LOCAL_AI_MODEL_ALLOWLIST_REVIEW'],
  });
  addProviderIfMissing(providers, 'local_path_reflection', {
    endpoint: localEndpoint,
    apiKey: localKey,
    model: source['LOCAL_AI_MODEL_PATH_REFLECTION'] ?? source['LOCAL_AI_MODEL_JUDGE'],
  });
}

function addUsageIfMissing(
  usages: Map<string, EnvUsage>,
  name: string,
  config: EnvUsage | null,
): void {
  if (!config || usages.has(name)) return;
  usages.set(name, config);
}

function buildLegacyUsageRouting(source: NodeJS.ProcessEnv, usages: Map<string, EnvUsage>): void {
  const hasPrimary = !!(source['AI_BASE_URL'] && source['AI_MODEL_REPLY']);
  if (!hasPrimary) return;

  addUsageIfMissing(usages, 'reply', {
    label: 'reply',
    backups: [],
  });
  addUsageIfMissing(usages, 'vision', {
    label: source['AI_MODEL_VISION'] ? 'vision' : 'reply',
    backups: [],
  });
  addUsageIfMissing(usages, 'judge', {
    label: source['LOCAL_AI_MODEL_JUDGE'] ? 'local_judge' : 'judge',
    backups: source['LOCAL_AI_MODEL_JUDGE'] ? ['judge'] : (source['AI_MODEL_REPLY'] ? ['reply'] : []),
    timeout: 30_000,
    maxTokens: 200,
    temperature: 0,
  });
  addUsageIfMissing(usages, 'summarize', {
    label: source['LOCAL_AI_MODEL_SUMMARIZE'] ? 'local_summarize' : 'summarize',
    backups: source['LOCAL_AI_MODEL_SUMMARIZE'] ? ['summarize'] : (source['AI_MODEL_REPLY'] ? ['reply'] : []),
    timeout: 120_000,
  });
  addUsageIfMissing(usages, 'allowlist_review', {
    label: source['LOCAL_AI_MODEL_ALLOWLIST'] || source['LOCAL_AI_MODEL_ALLOWLIST_REVIEW']
      ? 'local_allowlist_review'
      : 'allowlist_review',
    backups:
      source['LOCAL_AI_MODEL_ALLOWLIST'] || source['LOCAL_AI_MODEL_ALLOWLIST_REVIEW']
        ? ['allowlist_review']
        : (source['AI_MODEL_REPLY'] ? ['reply'] : []),
    timeout: 60_000,
  });
  addUsageIfMissing(usages, 'path_reflection', {
    label: source['LOCAL_AI_MODEL_PATH_REFLECTION'] ? 'local_path_reflection' : 'path_reflection',
    backups:
      source['LOCAL_AI_MODEL_PATH_REFLECTION']
        ? ['path_reflection']
        : (source['AI_MODEL_JUDGE'] ? ['judge'] : (source['AI_MODEL_REPLY'] ? ['reply'] : [])),
    timeout: 20_000,
    maxTokens: 200,
    temperature: 0,
  });
  addUsageIfMissing(usages, 'reply_splitter', {
    label: source['AI_MODEL_REPLY_SPLITTER'] ? 'reply_splitter' : 'reply',
    backups: source['AI_MODEL_REPLY'] ? ['reply'] : [],
    timeout: 30_000,
    maxTokens: 500,
    temperature: 0,
  });
}

/**
 * Parse AI_PROVIDER_<NAME>_ENDPOINT/KEY/MODEL/FORMAT/STREAM from process.env.
 * Provider names are lowercased from the env key.
 * Also synthesizes legacy AI_BASE_URL / AI_MODEL_* routing so fresh setups and migrations keep working.
 */
export function getProviders(): Map<string, EnvProvider> {
  if (_providers) return _providers;

  const source = process.env;
  const groups = new Map<string, Record<string, string>>();

  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('AI_PROVIDER_') || !value) continue;
    const rest = key.slice('AI_PROVIDER_'.length);
    const fields = ['ENDPOINT', 'KEY', 'MODEL', 'FORMAT', 'STREAM', 'REASONING', 'THINKING', 'INSECURE', 'TIMEOUT', 'MAX_TOKENS', 'TEMPERATURE', 'RAW', 'VISION', 'VIDEO', 'TIER'] as const;
    let matchedField: string | undefined;
    let providerName: string | undefined;
    for (const f of fields) {
      if (rest.endsWith(`_${f}`)) {
        matchedField = f;
        providerName = rest.slice(0, -(f.length + 1));
        break;
      }
    }
    if (!matchedField || !providerName) continue;
    const name = providerName.toLowerCase();
    if (!groups.has(name)) groups.set(name, {});
    groups.get(name)![matchedField] = value;
  }

  _providers = new Map();
  for (const [name, fields] of Array.from(groups.entries())) {
    if (!fields['ENDPOINT'] || !fields['MODEL']) continue;
    _providers.set(name, {
      name,
      endpoint: fields['ENDPOINT'],
      apiKey: fields['KEY'] ?? '',
      model: fields['MODEL'],
      apiFormat: fields['FORMAT'] === 'claude' ? 'claude' : undefined,
      stream: readBool(fields['STREAM']),
      reasoningEffort: fields['REASONING'] as 'none' | 'low' | 'medium' | 'high' | undefined,
      disableThinking: fields['THINKING'] === 'disabled',
      insecureTLS: readBool(fields['INSECURE']),
      forceRaw: readBool(fields['RAW']),
      timeout: (() => { const n = fields['TIMEOUT'] ? parseInt(fields['TIMEOUT'], 10) : NaN; return Number.isFinite(n) && n > 0 ? n : undefined; })(),
      maxTokens: (() => { const n = fields['MAX_TOKENS'] ? parseInt(fields['MAX_TOKENS'], 10) : NaN; return Number.isFinite(n) && n > 0 ? n : undefined; })(),
      // round 12（新 goal）：支持字面量 `omit` —— 这个 label 不要传 temperature 字段。
      // dshkimi 实测：传 1 → 同 prompt 6 次翻 1 次；不传 → 6/6 一致。
      // 详见 AILabel.temperature 的注释。
      temperature: (() => {
        const raw = fields['TEMPERATURE'];
        if (!raw) return undefined;
        if (raw.trim().toLowerCase() === 'omit') return 'omit' as const;
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : undefined;
      })(),
      vision: readBool(fields['VISION']),
      video: readBool(fields['VIDEO']),
      tier: (fields['TIER'] === 'high' || fields['TIER'] === 'low') ? fields['TIER'] : (fields['TIER'] === 'medium' ? 'medium' : undefined),
    });
  }

  buildLegacyProviders(source, _providers);
  return _providers;
}

/**
 * Parse AI_USAGE_<NAME>_LABEL/BACKUPS/TIMEOUT/MAX_TOKENS/TEMPERATURE/JSON_MODE from process.env.
 * Usage names are lowercased (with underscores preserved for multi-word names like REPLY_PRO).
 * Also synthesizes compatibility routing for legacy AI_MODEL_* envs when explicit AI_USAGE_* entries are absent.
 */
export function getUsageRouting(): Map<string, EnvUsage> {
  if (_usages) return _usages;

  const source = process.env;
  const groups = new Map<string, Record<string, string>>();

  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('AI_USAGE_') || !value) continue;
    const rest = key.slice('AI_USAGE_'.length);
    const fields = ['LABEL', 'BACKUPS', 'TIMEOUT', 'MAX_TOKENS', 'TEMPERATURE', 'JSON_MODE'] as const;
    let matchedField: string | undefined;
    let usageName: string | undefined;
    for (const f of fields) {
      if (rest.endsWith(`_${f}`)) {
        matchedField = f;
        usageName = rest.slice(0, -(f.length + 1));
        break;
      }
    }
    if (!matchedField || !usageName) continue;
    const name = usageName.toLowerCase();
    if (!groups.has(name)) groups.set(name, {});
    groups.get(name)![matchedField] = value;
  }

  _usages = new Map();
  for (const [name, fields] of Array.from(groups.entries())) {
    if (!fields['LABEL']) continue;
    _usages.set(name, {
      label: fields['LABEL'].toLowerCase(),
      backups: fields['BACKUPS']
        ? fields['BACKUPS'].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        : [],
      timeout: readNumber(fields['TIMEOUT']),
      maxTokens: readNumber(fields['MAX_TOKENS']),
      temperature: readNumber(fields['TEMPERATURE']),
      jsonMode: fields['JSON_MODE'] !== undefined
        ? /^(1|true|yes|on)$/i.test(fields['JSON_MODE'])
        : undefined,
    });
  }

  buildLegacyUsageRouting(source, _usages);
  return _usages;
}

export function _resetEnvRoutingCache(): void {
  _providers = undefined;
  _usages = undefined;
}
