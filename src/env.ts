import { z } from 'zod';
import 'dotenv/config';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  // Telegram
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  BOT_USERNAME: z.string().min(1).default('xxb_bot'),

  // Redis
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379/0'),

  // SQLite
  SQLITE_PATH: z.string().default('./data/xxb.db'),

  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Webhook (optional — use polling if not set)
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().optional(),

  // Queue
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(20),

  // AI tuning
  HEDGE_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),

  // Rate limiting
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(30),

  // Streaming
  STREAMING_MIN_INTERVAL: z.coerce.number().int().nonnegative().default(500),
  STREAMING_MIN_CHARS: z.coerce.number().int().nonnegative().default(50),

  // Tool System
  SKILLS_DIR: z.string().default('./data/skills'),
  SEARXNG_URL: z.string().url().optional(),
  XAI_API_KEY: z.string().optional(),
  XAI_SEARCH_MODEL: z.string().default('grok-4-0709'),
  FETCH_GATEWAY_URL: z.string().optional(),
  FETCH_WORKER_URL: z.string().url().optional(),
  NODESEEK_READER_URLS: z.string().optional(),
  WEB_FETCH_USER_AGENT: z.string().default('XXB-WebFetch/1.0'),
  IP_QUALITY_API_URL: z.string().url().optional(),
  TIMER_API_URL: z.string().url().optional(),
  TIMER_CALLBACK_URL: z.string().url().optional(),
  COMMON_API_KEY: z.string().optional(),

  // Tracking
  OUTCOME_TRACKING_ENABLED: booleanFromEnv.default(false),

  // Business
  MASTER_UID: z.coerce.number().int().default(0),
  MASTER_UID_EXTRA: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n > 0);
    }),
  BOT_NICKNAMES: z
    .string()
    .default('xxb,啾咪囝')
    .transform((s) => s.split(',')),
  CONTEXT_MAX_LENGTH: z.coerce.number().int().positive().default(600),
  JUDGE_WINDOW_SIZE: z.coerce.number().int().positive().default(10),

  // Knowledge base (file-backed, PHP parity)
  KNOWLEDGE_BASE_DIR: z.string().default('./data/knowledge'),
  JUDGE_KNOWLEDGE_ENABLED: booleanFromEnv.default(false),
  JUDGE_KNOWLEDGE_PERMANENT: booleanFromEnv.default(true),
  JUDGE_KNOWLEDGE_GROUP: booleanFromEnv.default(true),

  // Join verification
  VERIFY_ENABLED: booleanFromEnv.default(false),
  VERIFY_DEFAULT_TIMEOUT: z.coerce.number().int().default(300),
  VERIFY_MAX_ATTEMPTS: z.coerce.number().int().default(3),

  // Knowledge cron (cron_long_term.php parity)
  KNOWLEDGE_CRON_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      try {
        const j = JSON.parse(t) as unknown;
        if (Array.isArray(j)) {
          return j.map((x) => Number(x)).filter((n) => !Number.isNaN(n) && n !== 0);
        }
      } catch {
        /* fall through */
      }
      return t
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => !Number.isNaN(n) && n !== 0);
    }),
  KNOWLEDGE_CRON_SCHEDULE: z.string().default('30 * * * *'),
  KNOWLEDGE_CRON_HASH_PATH: z.string().optional(),

  // Channel source IDs — channel posts from these channels are ingested into ChromaDB as knowledge
  CHANNEL_SOURCE_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => !Number.isNaN(n) && n !== 0);
    }),

  // Public channel usernames to scrape (no admin needed, uses t.me/s/ web page)
  CHANNEL_SOURCE_USERNAMES: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as string[];
      return t.split(',').map((x) => x.trim().replace(/^@/, '')).filter(Boolean);
    }),

  // Persona override directory (per-user {uid}.md / .txt)
  PERSONA_DIR: z.string().optional(),

  // Allowlist
  ALLOWLIST_ENABLED: booleanFromEnv.default(false),
  ALLOWLIST_REDIS_PREFIX: z.string().default('xxb:mal:'),
  ALLOWLIST_DEFAULT_ENABLE_AFTER_APPROVE: booleanFromEnv.default(false),
  ALLOWLIST_MAX_SUBMISSIONS_PER_DAY: z.coerce.number().int().default(20),
  ALLOWLIST_AUTO_AI_REVIEW: booleanFromEnv.default(true),
  ALLOWLIST_AI_MESSAGE_LIMIT: z.coerce.number().int().default(100),
  ALLOWLIST_AI_CONTEXT_MAX_CHARS: z.coerce.number().int().default(24000),
  ALLOWLIST_AI_AUTO_ENABLE: booleanFromEnv.default(true),
  ALLOWLIST_AI_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.85),

  // ── Proactive Engagement (Stage B) ──
  JUDGE_PROACTIVE_ENABLED: booleanFromEnv.default(false),
  JUDGE_PROACTIVE_RATE: z.coerce.number().min(0).max(1).default(0.05),
  JUDGE_PROACTIVE_MIN_INTERVAL_SEC: z.coerce.number().int().positive().default(600),
  JUDGE_PROACTIVE_MIN_RECENT_MSGS: z.coerce.number().int().positive().default(3),

  // ── Proactive Scan Cron (Stage C) ──
  PROACTIVE_SCAN_ENABLED: booleanFromEnv.default(false),
  PROACTIVE_SCAN_INTERVAL_MIN: z.coerce.number().int().positive().default(5),
  PROACTIVE_SCAN_USAGE: z.string().default('judge'),
  PROACTIVE_SCAN_MIN_INTERVAL_SEC: z.coerce.number().int().positive().default(900),
  PROACTIVE_SCAN_MAX_CHATS_PER_TICK: z.coerce.number().int().positive().default(3),
  PROACTIVE_SCAN_RECENT_MSG_COUNT: z.coerce.number().int().positive().default(15),
  PROACTIVE_SCAN_MIN_HUMAN_MSGS: z.coerce.number().int().positive().default(5),
  PROACTIVE_SCAN_HOUR_START: z.coerce.number().int().min(0).max(23).default(10),
  PROACTIVE_SCAN_HOUR_END: z.coerce.number().int().min(0).max(23).default(23),
  // shouldChimeIn LLM call timeout (ms). Default 10s — should accommodate fallback chains.
  PROACTIVE_SCAN_CHIME_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),

  // ── Timing Gate (MaiBot-style: debounce + state machine + LLM gate) ──
  // 全局开关。关闭时所有 timing 模块退化为透传，行为等价于改造前。
  TIMING_GATE_ENABLED: booleanFromEnv.default(false),
  // 阶段 1：消息去抖窗口（毫秒）。0 = 关闭去抖。
  // 同一 chat 内，新消息会重置定时器；超过 MAX_BUFFER_MS 强制 flush 防止饥饿。
  TIMING_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(2000),
  TIMING_DEBOUNCE_MAX_BUFFER_MS: z.coerce.number().int().nonnegative().default(8000),
  // 阶段 2：ChatRuntime 状态过期时间（秒）。超过则视作 STOP 默认状态。
  TIMING_STATE_TTL_SEC: z.coerce.number().int().positive().default(86400),
  // 阶段 3：Timing Gate LLM usage label。默认走 judge usage（小模型）。
  TIMING_GATE_USAGE: z.string().default('judge'),
  TIMING_GATE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  // 阶段 4：wait 工具最大允许秒数；超过会被裁剪。
  TIMING_WAIT_MAX_SEC: z.coerce.number().int().positive().default(120),
  TIMING_WAIT_MIN_SEC: z.coerce.number().int().positive().default(5),
  // 阶段 4：gate 选 wait/no_action 后，下次再调 gate 的冷却时间（秒）。
  // 对应 MaiBot 的 timing_gate_non_continue_cooldown_seconds。
  TIMING_GATE_COOLDOWN_SEC: z.coerce.number().int().nonnegative().default(15),

  // ── Learner (Expression + Jargon, Stage D) ──
  LEARNER_ENABLED: booleanFromEnv.default(false),
  LEARNER_SCAN_INTERVAL_MIN: z.coerce.number().int().positive().default(60),
  LEARNER_SCAN_USAGE: z.string().default('judge'),
  LEARNER_BATCH_SIZE: z.coerce.number().int().positive().default(80),
  LEARNER_MIN_NEW_MSGS: z.coerce.number().int().positive().default(30),
  LEARNER_MAX_CHATS_PER_TICK: z.coerce.number().int().positive().default(3),
  EXPRESSION_INJECT_ENABLED: booleanFromEnv.default(false),
  EXPRESSION_INJECT_COUNT: z.coerce.number().int().positive().default(5),
  JARGON_INFERENCE_THRESHOLDS: z.string().default('4,8,25,100'),
  JARGON_QUERY_ENABLED: booleanFromEnv.default(false),

  // ── Idle proactive cron (group has been silent → poke) ──
  // Bot 在群沉默超过 N 秒后，以 P 概率主动发一句活跃群聊。
  // 同一群两次主动开口的最小间隔（默认 24h，一天最多 1 次）
  IDLE_PROACTIVE_INTERVAL_SEC: z.coerce.number().int().positive().default(86400),
  IDLE_THRESHOLD_SEC: z.coerce.number().int().positive().default(3600),
  IDLE_TRIGGER_PROBABILITY: z.coerce.number().min(0).max(1).default(0.1),
  IDLE_HOUR_START: z.coerce.number().int().min(0).max(23).default(10),
  IDLE_HOUR_END: z.coerce.number().int().min(0).max(23).default(23),

  // ── Mood drift (Stage E) ──
  // Bot 每个群独立 valence ∈ [-100, 100]，随事件起伏，按时间向 0 衰减。
  MOOD_ENABLED: booleanFromEnv.default(false),
  // 每小时衰减比例 (0..1)。0.3 = 1 小时后保留 70% 强度
  MOOD_DECAY_RATE_PER_HOUR: z.coerce.number().min(0).max(1).default(0.3),
  // 是否把 mood hint 注入 reply prompt
  MOOD_INJECT_ENABLED: booleanFromEnv.default(false),
  // |valence| < 该阈值时不注入 prompt（默认 calm 不打扰）
  MOOD_INJECT_THRESHOLD: z.coerce.number().int().nonnegative().default(20),

  // ── Self-narrative (Stage F): bot 记得自己对每个用户说过什么 ──
  SELF_HISTORY_ENABLED: booleanFromEnv.default(false),
  SELF_HISTORY_INJECT_LIMIT: z.coerce.number().int().positive().default(5),
  SELF_HISTORY_WINDOW_DAYS: z.coerce.number().int().positive().default(30),

  // ── Relationship narrative (Stage F): 每对 (chat,user) 累计 affinity ──
  RELATIONSHIP_ENABLED: booleanFromEnv.default(false),
  // |affinity| < 该值时不注入 prompt（默认 一般 关系不打扰）
  RELATIONSHIP_INJECT_THRESHOLD: z.coerce.number().int().nonnegative().default(20),

  // Monitor
  MONITOR_TOKEN: z.string().default(''),

  // Admin
  ADMIN_CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) => (s ? s.split(',') : [])),

  // Cutover (optional — only used by scripts/cutover.sh)
  TS_WEBHOOK_URL: z.string().url().optional(),
  PHP_WEBHOOK_URL: z.string().url().optional(),
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
}

export interface EnvUsage {
  label: string;
  backups: string[];
  timeout?: number;
  maxTokens?: number;
  temperature?: number;
}

let _providers: Map<string, EnvProvider> | undefined;
let _usages: Map<string, EnvUsage> | undefined;
let _replyMaxLabels: string[] | undefined;

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
  addProviderIfMissing(providers, 'reply_pro', {
    endpoint: primaryEndpoint,
    apiKey: primaryKey,
    model: source['AI_MODEL_REPLY_PRO'],
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
    backups: source['AI_MODEL_REPLY_PRO'] ? ['reply_pro'] : [],
  });
  addUsageIfMissing(usages, 'reply_pro', {
    label: source['AI_MODEL_REPLY_PRO'] ? 'reply_pro' : 'reply',
    backups: source['AI_MODEL_REPLY'] ? ['reply'] : [],
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
    const fields = ['ENDPOINT', 'KEY', 'MODEL', 'FORMAT', 'STREAM', 'REASONING', 'THINKING'] as const;
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
    });
  }

  buildLegacyProviders(source, _providers);
  return _providers;
}

/**
 * Parse AI_USAGE_<NAME>_LABEL/BACKUPS/TIMEOUT/MAX_TOKENS/TEMPERATURE from process.env.
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
    const fields = ['LABEL', 'BACKUPS', 'TIMEOUT', 'MAX_TOKENS', 'TEMPERATURE'] as const;
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
    });
  }

  buildLegacyUsageRouting(source, _usages);
  return _usages;
}

/**
 * Parse AI_USAGE_REPLY_MAX_LABELS (comma-separated provider names for rotating reply_max pool).
 */
export function getReplyMaxLabels(): string[] {
  if (_replyMaxLabels) return _replyMaxLabels;
  const raw = process.env['AI_USAGE_REPLY_MAX_LABELS'];
  _replyMaxLabels = raw
    ? raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  return _replyMaxLabels;
}

export function _resetEnvRoutingCache(): void {
  _providers = undefined;
  _usages = undefined;
  _replyMaxLabels = undefined;
}
