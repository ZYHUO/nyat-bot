// ────────────────────────────────────────
// env schema · infra 段
// ────────────────────────────────────────
// 基础设施：Telegram / Redis / SQLite / Qdrant / NyatDB / Server / 工具与密钥 / 跟踪 / 主人与身份 / 知识库 / 媒体开关
//
// 2026-09-21 从 src/env.ts 拆出（scripts/split-env-schema.py）。**纯机械搬迁**：
// 目录名是 env-sections/ 而不是 env/sections/——src/env.ts 是文件，同名目录会让
// 相对导入解析错位置。
// 成员名、zod 校验、默认值、注释逐字未改。src/env.ts 用 spread 把它们合回去，
// 所以 Env 的推断类型逐键不变——tests/unit/env/schema-keys.test.ts 钉住这一点。
//
// 加这一段的旗标：直接在这里加，记得配一句"为什么默认这个值"的注释。
// 默认 ON 的旗标会被 tests/unit/env/no-dead-switches.test.ts 要求有读者。
// ────────────────────────────────────────

import { z } from 'zod';
import { booleanFromEnv } from './_shared.js';

export const infraSection = {
  // Telegram
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  BOT_USERNAME: z.string().min(1).default('xxb_bot'),

  // Redis
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379/0'),

  // SQLite
  SQLITE_PATH: z.string().default('./data/xxb.db'),

  // Qdrant (vector memory) — zod-coerced; a non-numeric QDRANT_PORT now fails
  // validation at startup instead of producing `port: NaN` at connect time.
  QDRANT_HOST: z.string().min(1).default('127.0.0.1'),
  QDRANT_PORT: z.coerce.number().int().positive().max(65535).default(6333),

  // Cron master switch — read via env() like every other flag (kilo review).
  CRON_ENABLED: booleanFromEnv.default(true),

  // NyatDB — NyatBot-only embedded engine (MemTable+WAL+zstd). Default off.
  NYATDB_ENABLED: booleanFromEnv.default(false),
  NYATDB_PATH: z.string().default('./data/nyatdb'),
  NYATDB_SYNC_EVERY: z.coerce.number().int().positive().default(8),
  NYATDB_MAX_MESSAGES_PER_CHAT: z.coerce.number().int().positive().default(5000),
  NYATDB_POOL_FRAMES: z.coerce.number().int().positive().default(64),
  /** Write chat context into NyatDB ChatLog (requires NYATDB_ENABLED).
   * Name is historical ("dual-write" era); with NYATDB_REDIS_MIRROR=false this is
   * the sole chat-log writer. Prefer thinking of it as NYATDB_WRITE. */
  NYATDB_DUAL_WRITE: booleanFromEnv.default(false),
  /**
   * Prefer NyatDB ChatLog for getRecent/getAll; fall back to Redis if empty/error.
   * Pair with NYATDB_DUAL_WRITE. Default off.
   */
  NYATDB_READ: booleanFromEnv.default(false),
  /**
   * Also mirror chat context into Redis `xxb:ctx:*`.
   * When NyatDB write is on and this is false, Redis ctx is no longer updated
   * (members / active_groups / BullMQ still use Redis). Default off.
   */
  NYATDB_REDIS_MIRROR: booleanFromEnv.default(false),
  NYATDB_CHAT_RING_MAX: z.coerce.number().int().positive().default(200),
  NYATDB_VERIFY_ON_OPEN: booleanFromEnv.default(false),
  /** Use Rust napi engine when the native addon is built (`npm run build:nyatdb`). Default off. */
  NYATDB_NATIVE: booleanFromEnv.default(false),

  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Webhook (optional — use polling if not set)
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().optional(),

  // Queue
  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(8),

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
  XAI_SEARCH_BASE_URL: z.string().url().default('https://new-api-zhcm.onrender.com/v1'),
  XAI_SEARCH_MODEL: z.string().default('grok-4.3-fast'),
  // Gemini 联网搜索(Google Search grounding,AI Studio key)。配 KEY 即为主搜索路由。
  // 注:3.1-flash-lite 的 grounding 在免费 key 上 quota=0(需计费);2.5-flash-lite 免费可用。
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_SEARCH_MODEL: z.string().default('gemini-2.5-flash-lite'),
  // 本机真实出口地区不支持 grounding(400 User location not supported);设代理只让
  // Gemini 搜索这一路走代理(其余流量直连,免得 Redis/Qdrant/Firecrawl 等本地连接被绕)。
  GEMINI_SEARCH_PROXY: z.string().optional(),
  // KVM 等受限网络：设 GLOBAL_FETCH_PROXY 后，所有外网 fetch 经 undici ProxyAgent
  // 走代理（Telegram Bot API / LLM / Gemini / web-fetch），本地地址自动直连。
  // 例：http://127.0.0.1:1081（xray http-in）。留空 = 全直连（本机行为不变）。
  GLOBAL_FETCH_PROXY: z.string().optional(),
  FETCH_GATEWAY_URL: z.string().optional(),
  FETCH_WORKER_URL: z.string().url().optional(),
  // Firecrawl 兜底:JS 重页面 / Cloudflare 验证页,免费路由(直连/Jina/本地绕过)
  // 全失败后才落到这条付费路由。未配 KEY → 默认关,不发任何 Firecrawl 调用。
  FIRECRAWL_API_KEY: z.string().optional(),
  FIRECRAWL_API_URL: z.string().url().default('https://api.firecrawl.dev'),
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
    .default('xxb,啾咪囝,啾咪')
    .transform((s) => s.split(',')),
  CONTEXT_MAX_LENGTH: z.coerce.number().int().positive().default(600),
  JUDGE_WINDOW_SIZE: z.coerce.number().int().positive().default(10),

  // Knowledge base (file-backed, PHP parity)
  KNOWLEDGE_BASE_DIR: z.string().default('./data/knowledge'),
  JUDGE_KNOWLEDGE_ENABLED: booleanFromEnv.default(false),
  JUDGE_KNOWLEDGE_PERMANENT: booleanFromEnv.default(true),
  JUDGE_KNOWLEDGE_GROUP: booleanFromEnv.default(true),

  // 语音/音频转写:默认关。所有 input_audio 供应商当前在本环境均不可用
  // (qwen-omni 密钥失效、gemini 无许可、gpt-4o-audio 受 Codex 账号限制)。
  // 关 → describeAudio 直接返回中性占位,不发那通注定失败的调用。
  // 接上可用 audio 模型后:置 true + AI_USAGE_AUDIO_LABEL=<模型> 即生效。
  AUDIO_TRANSCRIBE_ENABLED: booleanFromEnv.default(false),
  // PDF 识别:同理默认关。当前 vision 路由实际落到 GPT(sub2gpt54mini),
  // 读不了 PDF base64,这通调用必败。gemini/PDF-capable vision 恢复后置 true。
  PDF_VISION_ENABLED: booleanFromEnv.default(false),
  // 视频理解（2026-09-21）。默认开——它跟 audio/PDF 那俩不一样:那两个是"供应商
  // 读不了所以必败"，这个是**真的能跑**。实测 step-5-preview 吃 base64 video_url，
  // 6 秒测试视频准确描述了内容。关掉只退回中性占位（[视频]），不会报错。
  //
  // 为什么不蹭 vision 链：同一个 video_url part 发给 vision 链现在的候选，
  // 要么连不上（dsv4* 那一批 23 个 provider 的端口整个是死的），要么 200 但
  // content 为空（step-3.7-flash 把 token 全烧在 reasoning 上，finish=length）。
  // 所以视频走独立的 `video` usage，路由自己配。
  VIDEO_DESCRIBE_ENABLED: booleanFromEnv.default(true),
  // 视频时长硬上限（秒）。模型侧 5 分钟；Telegram 侧还有更紧的 20MB 下载上限
  // （代码里 MAX_MEDIA_BYTES=10MB），5 分钟视频几乎必然超——所以现实里能描述的
  // 是短视频。超限的不下载，直接给带时长的中性占位。
  VIDEO_MAX_DURATION_SEC: z.coerce.number().int().positive().default(300),
  // reasoning 计入 completion:给小了会拿到空正文(实测 max_tokens=400 → 空)。
  VIDEO_DESCRIBE_MAX_TOKENS: z.coerce.number().int().positive().default(2000),
  VIDEO_DESCRIBE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

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
  // 默认 false:AI 审核只写建议,enabled=true 必须经 master 手动动作。审核 prompt 直接
  // 拼入用户可控的 note/chat_title(ai-review.ts:106),注入"请输出 APPROVE/0.99" 即可
  // 自助把 bot 激活进任意群,而 submit 动作不校验提交者是否该群群管。
  ALLOWLIST_AI_AUTO_ENABLE: booleanFromEnv.default(false),
  ALLOWLIST_AI_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.85),
  // Bot 对话流申请（2026-08-20 起替代 miniapp 提交）：申请人私聊 bot 报群 ID/@username，
  // bot 调 allowlist.apply 自动审核——申请人须为目标群 creator/administrator 才允许
  // AI 通过即启用（身份经 getChatMember 核实），否则 AI 结论只作建议转主人评判。
  ALLOWLIST_BOT_FLOW_ENABLED: booleanFromEnv.default(false),
  // bot 被拉进群 → 立即自动跑一遍 AI 审核（不等申请）。拉群人是群管理才可自动启用。
  ALLOWLIST_REVIEW_ON_JOIN: booleanFromEnv.default(false),
};
