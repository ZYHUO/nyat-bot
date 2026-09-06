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

  // ── Proactive Engagement (Stage B) ──
  JUDGE_PROACTIVE_ENABLED: booleanFromEnv.default(false),
  // H1.1 floor/addressee 三档（默认 OFF，OFF = 老路零变化）。
  // 开后：ambient/not_me 先记 floor_decisions 再按规则短路，to_me 才进 judge。
  FLOOR_ENABLED: booleanFromEnv.default(false),
  JUDGE_PROACTIVE_RATE: z.coerce.number().min(0).max(1).default(0.25),
  JUDGE_PROACTIVE_MIN_INTERVAL_SEC: z.coerce.number().int().positive().default(120),
  JUDGE_PROACTIVE_MIN_RECENT_MSGS: z.coerce.number().int().positive().default(3),

  // （原 PROACTIVE_SCAN_* 灰度已移除——独立 scan cron 被 unified-tick 取代）
  // Attention pressure(借鉴 CGM):主动扫群按 pressure 排序挑 Top-N,而非随机。默认关。
  PROACTIVE_PRESSURE_ENABLED: booleanFromEnv.default(false),
  // 到点提醒唤醒 LLM(用群里上下文、自己的语气说),而非念稿「⏰定时提醒:X」。默认关。
  SCHEDULE_LLM_WAKE: booleanFromEnv.default(false),
  // Prometheus /metrics(借鉴 CGM:LLM 事件总线 → token/缓存/延迟按用途可见)。默认关。
  METRICS_ENABLED: booleanFromEnv.default(false),
  // 跨群人物身份(借鉴 CGM 两层人物模型):在别的群也认得的人,带上跨群整体印象。默认关。
  PERSON_IDENTITY_ENABLED: booleanFromEnv.default(false),
  // ── DM↔群记忆连结(借鉴 CyberGroupmate 以人为中心统一记忆;docs/dm-group-memory-*.md)──
  // 机制1 隐私 visibility 兜底:记忆/画像跨上下文返回前按 private/contextual/public
  // 逐条 scrub(DM 默认 private,群默认 contextual)。是机制3/4 跨上下文共享的前置门,
  // 关闭时跨上下文入口一律 fail-closed 拒绝返回。默认关。
  MEMORY_VISIBILITY_ENABLED: booleanFromEnv.default(false),
  // 始终视作私密的会话(逗号分隔 chatId;群为负数)。DM 由 DM_AUTO_PRIVATE 自动判定。
  MEMORY_SENSITIVE_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n !== 0);
    }),
  // DM 是否自动判为私密会话(CGM dmAutoPrivate)。默认 true。
  DM_AUTO_PRIVATE: booleanFromEnv.default(true),
  // 机制5 LLM 全局画像合并 cron:低频把某人各上下文(群+DM)画像喂便宜模型提炼成
  // 全局 traits/interests/relation,写回 person_identity 全局列。默认关。
  PROFILE_MERGE_ENABLED: booleanFromEnv.default(false),
  // 合并灰度群列表(逗号分隔 chatId,群为负数),空 = 对所有上下文生效。
  PROFILE_MERGE_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n !== 0);
    }),
  // 全局画像合并走哪个便宜模型 usage 路由。
  PROFILE_MERGE_USAGE: z.string().default('summarize'),
  // 机制4 跨上下文记忆召回:per-uid 旁路检索(不锁 chatId),返回强制过 visibility
  // scrub(默认带 public + 非私密来源 contextual,private 一律剔除)。
  // **必须** MEMORY_VISIBILITY_ENABLED 也开才生效(fail-closed)。默认关。
  MEMORY_CROSS_CONTEXT_ENABLED: booleanFromEnv.default(false),
  // ── 长期记忆嵌入模型 / collection / 相关性下限 ──────────────
  // 默认的 all-MiniLM-L6-v2 是**英文单语**模型,而本 bot 是中文群聊。生产机实测中文
  // 同义 0.7543 / 无关 0.6097 → 区分度仅 0.1446(「打篮球」vs「查比特币价格」相似度
  // 0.7210,比英文同义句对的 0.7025 还高),即语义检索接近随机。
  // paraphrase-multilingual-MiniLM-L12-v2 同为 384 维、区分度 0.5592(3.9x)。
  // 换模型后新旧向量空间不兼容,**必须整库重嵌入**:scripts/reembed-memory.ts 灌进
  // 新 collection → 改 MEMORY_COLLECTION 切换 → 旧库保留一周作回滚。
  MEMORY_EMBED_MODEL: z.string().default('Xenova/all-MiniLM-L6-v2'),
  MEMORY_COLLECTION: z.string().default('xxb_group_history'),
  // 检索相关性下限(0..1)。0 = 不过滤,保持历史行为(纯 topK)。
  // 换模型与调阈值刻意分成两次改动;标定必须用真实语料,别沿用旧模型下的经验值。
  MEMORY_MIN_SCORE: z.coerce.number().min(0).max(1).default(0),
  // 混合检索:向量召回 + FTS5 BM25 词法召回,按 RRF(名次融合)合并。
  // 384 维小模型对专有名词/群内黑话/型号天然弱(jargon-miner 挖的正是这类词),
  // BM25 补的就是这一块。关闭时完全走旧的纯向量路径。默认关。
  MEMORY_HYBRID_ENABLED: booleanFromEnv.default(false),
  // 写入侧近重复合并:命中已有近邻时不新增点,改为顶高它的 ref_count
  // (「这件事又被说了一次」语义上是强化,不是复制)。压制「哈哈哈」「+1」这类刷屏。
  // **阈值必须在换完嵌入模型之后标定** —— 旧的英文单语模型下中文相似度普遍虚高
  // (无关句对都有 0.72),0.93 在旧向量空间里会命中几乎一切,等于把记忆写没了。默认关。
  MEMORY_DEDUP_ENABLED: booleanFromEnv.default(false),
  MEMORY_DEDUP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.93),
  // ── CodeAct 自动注入长期记忆 ──────────────────────────────
  // 接在 subagent/executor.ts(真正生成话语的那层),**不是** Meta 编排器 ——
  // Meta 的引擎跨所有会话,其输出经 digest/梦境日记扩散到每个群的 prompt,
  // 私聊记忆进 Meta 就有一条通往别的群的洗白路径(与那次"私聊原文被念到群里"同源)。
  SUBAGENT_MEMORY_ENABLED: booleanFromEnv.default(false),
  // 灰度名单。**空 = 关闭**,与本仓其他 flag 的「空 = 全量」刻意相反:
  // 这是隐私相关特性,配错的代价不对称 —— 漏开只是没效果,误开是内容外泄。
  SUBAGENT_MEMORY_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n !== 0);
    }),
  SUBAGENT_MEMORY_TOPK: z.coerce.number().int().min(1).max(10).default(3),
  // 上下界都要:下界防 `TIMEOUT-50` 变成 0 导致「记忆永远为空且与无命中不可区分」,
  // 上界防有人调大后阻塞 CodeAct(那是生产热路径)。
  SUBAGENT_MEMORY_TIMEOUT_MS: z.coerce.number().int().min(100).max(1000).default(400),
  SUBAGENT_MEMORY_MAX_CHARS: z.coerce.number().int().min(100).max(2000).default(600),
  // 话题生命周期注册表(借鉴 CGM Topic Registry):cron 抽取各群当前话题 + 注入「当前话题」。默认关。
  TOPIC_REGISTRY_ENABLED: booleanFromEnv.default(false),
  TOPIC_SCAN_INTERVAL_MIN: z.coerce.number().int().positive().default(8),
  // 优化:direct 模式只取最近 N 条(原 50)——砍掉不可缓存的上下文体积,降 token/延迟。
  REPLY_DIRECT_RECENT_WINDOW: z.coerce.number().int().positive().default(30),
  // 优化:缓存预热——定时拿静态 system 前缀 ping 回复模型,保持 DeepSeek 前缀缓存热(默认关)。
  CACHE_WARMUP_ENABLED: booleanFromEnv.default(false),
  CACHE_WARMUP_INTERVAL_MIN: z.coerce.number().int().positive().default(4),
  // DM↔群联动:睡着时收到私聊 → 全局临时唤醒(群里也醒、正常处理消息),窗口内每条 DM 续期,
  // 静默后到点自动继续睡。默认关。
  SLEEP_WAKE_ON_DM_ENABLED: booleanFromEnv.default(false),
  SLEEP_WAKE_WINDOW_MIN: z.coerce.number().int().positive().default(20),
  // 回复写手强制合法 JSON(DeepSeek/OpenAI json_object)——根治单引号/Python-dict 脏输出。默认关。
  REPLY_JSON_MODE: booleanFromEnv.default(false),
  // P2 多模态直读:回复写手调用直接带原图(默认关 = 只用文本描述)。
  // 开前确保回复链主 label 声明 AI_PROVIDER_<NAME>_VISION=true,
  // 纯文本 label 声明 VISION=false 让 fallback 跳过(不白烧 400)。
  REPLY_VISION_ENABLED: booleanFromEnv.default(false),

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
  // no_action 指数退避(MaiBot 借鉴):窗口 = base * 2^max(0, n-START),
  // 即第 START_COUNT+1 次 no_action 起开始翻倍,封顶 CAP;continue/真实
  // 回复清零计数。
  NO_ACTION_BACKOFF_START_COUNT: z.coerce.number().int().nonnegative().default(2),
  NO_ACTION_BACKOFF_CAP_SEC: z.coerce.number().int().positive().default(300),
  // P0-A 连续对话免检:gate continue / bot 回复后 N 秒内的后续消息跳过 gate LLM
  // (对齐 MaiBot 连续 Planner 状态)。更新的 wait/no_action 负向决策自动终止免检。
  TURN_GATE_CONTINUATION: booleanFromEnv.default(false),
  TIMING_CONTINUATION_WINDOW_SEC: z.coerce.number().int().positive().default(180),
  // P0-B defer=延迟重评:同一条消息最多被 defer 重排几次(超限按旧语义静默丢弃)。
  TURN_GATE_DEFER_MAX_REPLAYS: z.coerce.number().int().nonnegative().default(1),
  // P1-C talk_value 频率阈值(0..1]:1.0 = 该层关闭(no-op)。<1 时非直接消息需攒
  // ceil(1/有效值) 条才评一次 gate,未达阈值 → defer 延迟重评;有空闲补偿兜底。
  // per-chat Redis 覆盖:xxb:timing:talkvalue:{chatId}。
  TIMING_TALK_VALUE: z.coerce.number().min(0.01).max(1).default(1.0),
  // ── 深度反思(A:把 StepFun 配额花在"让 bot 记住群里发生过什么")──
  // 后台 cron 对活跃群喂大窗口历史 → 产出每群"近况摘要"注入回复。吞吐可调:
  // token/天 ≈ CHATS_PER_TICK × (WINDOW×~15) × (1440/INTERVAL_MIN)。默认关。
  REFLECTION_ENABLED: booleanFromEnv.default(false),
  REFLECTION_INTERVAL_MIN: z.coerce.number().int().positive().default(30),
  REFLECTION_CHATS_PER_TICK: z.coerce.number().int().positive().default(20),
  REFLECTION_WINDOW_MSGS: z.coerce.number().int().positive().default(250),
  REFLECTION_USAGE: z.string().default('summarize'),
  // ── AGI Level 4 P4-A: 经验沉淀（常驻）─────────────────────────────────
  // 任务终态复盘蒸馏成 episode + 可复用经验；开工前按 contentDirection
  // 检索相关经验注入 executor prompt。复盘走便宜链，失败静默不重试。
  DISTILL_USAGE: z.string().default('summarize'),
  // ── 自我技能沉淀（AGI 自我 skill 系统）────────────────────────────────
  // 每 6h 从 episodes + experience_entries 蒸馏「小 skill」,每周合并去重
  // 成「大 skill」并归档小 skill 防爆。skill 是结构化能力单元(触发条件/
  // 步骤/坑),区别于碎片化经验。开工前按 contentDirection 检索注入。
  SKILL_DISTILL_ENABLED: booleanFromEnv.default(false),
  SKILL_DISTILL_USAGE: z.string().default('summarize'),
  SKILL_DISTILL_INTERVAL_MIN: z.coerce.number().int().positive().default(360),
  SKILL_CONSOLIDATE_ENABLED: booleanFromEnv.default(false),
  SKILL_CONSOLIDATE_USAGE: z.string().default('judge'),
  SKILL_MAX_BIG: z.coerce.number().int().min(1).default(50),
  // ── 爱好系统（从群友爱好蒸馏 bot 自己的爱好）────────────────────────
  // 聚合群友常聊话题 → LLM 蒸馏成 bot 自己的爱好 → 注入 self-state。
  // 慢变量(几天重蒸馏一次),区别于 obsessions 的 3h 短周期轮换。
  HOBBY_DISTILL_ENABLED: booleanFromEnv.default(false),
  HOBBY_DISTILL_USAGE: z.string().default('summarize'),
  // ── AGI Level 5 Phase 1: 经验验证器（常驻）────────────────────────────
  // 注入的经验在任务终态打分：done+干净路径 → success_count；failed →
  // failure_count。成功≥2 次 → verified=1(已证实)，失败≥2 次 → verified=2
  // (可疑，检索降权)。防「一次侥幸成功被固化」(Practice Makes Unsafe)。
  EXPERIENCE_VERIFY_ENABLED: booleanFromEnv.default(false),
  EXPERIENCE_VERIFY_MIN_SUCCESS: z.coerce.number().int().min(1).default(2),
  // ── AGI Level 5 Phase 2: Dreaming 整合 ───────────────────────────────
  // 每周一次语义合并冗余/冲突经验(MindMemOS dreaming)。走 judge 链。
  DREAM_CONSOLIDATE_ENABLED: booleanFromEnv.default(false),
  DREAM_CONSOLIDATE_USAGE: z.string().default('judge'),
  // ── AGI Level 5 Phase 3: 长期任务语义 ────────────────────────────────
  // goal 升级为跨周持续关注:check_goal 主动探查世界悄悄的变化(VibeLifeBench)。
  // long_term goal 的 stale 窗口放宽到 30 天。
  GOAL_LONG_TERM_ENABLED: booleanFromEnv.default(false),
  // ── Phase 2: 证据门学习 ──────────────────────────────────────────
  // 默认 OFF:OFF 时行为与 Phase-2 之前一致(legacy 直写路径)。
  // 开启后:goal achieved 必须 host verified;skill verified_use 独立计数;自改 prompt 受冷却/长度限制。
  GOAL_EVIDENCE_GATE_ENABLED: booleanFromEnv.default(false),
  SKILL_VERIFIED_USE_ENABLED: booleanFromEnv.default(false),
  SELF_EDIT_GUARDRAILS_ENABLED: booleanFromEnv.default(false),
  // ── AGI Level 5 Phase 4: Loop 策略资产化 ─────────────────────────────
  // executor 循环策略(验证/重试/停止)从静态升级为可进化资产:
  // 注入 prompt + 任务终态计数,成功率 <30% 自动 disable。
  LOOP_POLICY_ENABLED: booleanFromEnv.default(false),
  LOOP_POLICY_MAX: z.coerce.number().int().min(1).default(5),
  // ── AGI Level 5 Phase 5: 多智能体安全共享 ─────────────────────────────
  // 只有 verified=1(已证实)的经验可跨 bot 共享;未验证/可疑仅本 bot 用。
  EXPERIENCE_SHARE_ENABLED: booleanFromEnv.default(false),
  // ── AGI Level 5 Phase 6: 轻量世界状态 ────────────────────────────────
  // 对象中心实体(person/project/topic)持续维护,goal check 开工前注入上下文。
  WORLD_STATE_ENABLED: booleanFromEnv.default(false),
  // ── AGI Level 5 Phase 8: Context rot 防护 ─────────────────────────────
  // 少召回+重排+最高信号放前(防「迷失在中间」/干扰项误导)。
  RECALL_BUDGET_ENABLED: booleanFromEnv.default(false),
  RECALL_MAX_EXPERIENCE: z.coerce.number().int().min(1).default(3),
  // ── AGI Level 5 Phase 9: 群体风格画像 ────────────────────────────────
  // LoSoNA: 每个群有自己的隐性规范,观察消息 → 推断 → 注入 reply。
  GROUP_NORMS_ENABLED: booleanFromEnv.default(false),
  GROUP_NORMS_INFER_USAGE: z.string().default('judge'),
  GROUP_NORMS_TTL_HOURS: z.coerce.number().int().min(1).default(6),
  // ── AGI Level 5 Phase 10: ToM 心智状态层 ─────────────────────────────
  // 回复前先想「对方想要什么/什么情绪/期待什么反应」,白捡的策略性收益。
  TOM_STATE_ENABLED: booleanFromEnv.default(false),
  // ── AGI Level 5 Phase 12: 记忆陈旧检测 ───────────────────────────────
  // 超期未确认 → stale 降权;变化词(换工作/分手) → 相关旧属性 stale。
  // 只检测不自动删;检索到 stale 时注明可能过时。
  MEMORY_FRESHNESS_ENABLED: booleanFromEnv.default(false),
  // ── AGI Level 6 Phase 13: Task 对象架构 ─────────────────────────────
  // 补 harness 的「执行+状态」:BullMQ 独立队列跑任务,与消息处理隔离。
  TASK_EXECUTOR_ENABLED: booleanFromEnv.default(false),
  TASK_MAX_ROUNDS: z.coerce.number().int().min(1).default(6),
  // ── AGI Level 6 Phase 14: 反向阀门 L7 ───────────────────────────────
  // 连接率埋点(新核心指标)+ 私聊风险分档。初期只记录不改行为。
  CONNECTIVITY_TRACKING_ENABLED: booleanFromEnv.default(false),
  // Phase 14.1 接线: DM 风险 → 写手提示 + humanizer 衰减。默认 OFF,OFF 时
  // currentRiskLevel 恒 low(提示/衰减全是 undefined,行为与改造前逐字节一致)。
  // 只在 DM(chatId > 0)生效,群聊零变化。
  REVERSE_VALVE_ENABLED: booleanFromEnv.default(false),
  // ── Core v2 Phase 0: Belief View + 黑板 ACL + L2 permission gate ──
  // 全部默认 OFF。Phase 0 是纯地基（新表+纯函数），不接任何主路径，
  // 开了也只影响 eval harness 和未来的 graylist 群。
  CORE_BELIEF_VIEW_ENABLED: booleanFromEnv.default(false),
  CORE_BLACKBOARD_ENABLED: booleanFromEnv.default(false),
  CORE_PERMISSION_GATE_ENABLED: booleanFromEnv.default(false),
  // 总开关（默认开；关掉则 isCoreChat 全 false，shadow 零开销）。
  CORE_V2_ENABLED: booleanFromEnv.default(true),
  // Phase 2 双写：旧表写入后同步 belief（读投影）。默认开（best-effort，
  // 失败只打日志不拦路）。关掉则 core_beliefs 停更，读侧照常。
  CORE_DUAL_WRITE: booleanFromEnv.default(true),
  // 灰度群，逗号分隔。空 = 全量生效（与 TURN_ACTOR/MULTI_AGENT 一致）。
  CORE_V2_CHAT_IDS: z.string().default(''),
  // Belief View 注入 prompt 的预算（Phase 2 才用，Phase 0 只定义）
  BELIEF_VIEW_INJECT_MAX: z.coerce.number().int().default(4),
  BELIEF_TTL_DEFAULT_SEC: z.coerce.number().int().default(7776000),
  // Phase 6：drive satiation 半衰期（秒，默认 6h，与 norms TTL 同量级）。
  // halflifeSec() 经 env() 读这里（Phase 6 前直读 process.env，已收敛）。
  CORE_DRIVE_SATIATION_HALFLIFE_SEC: z.coerce.number().int().positive().default(21600),
  // 谄媚审计: 每周抽 200 条回复按五维打分,纯离线。
  SYCOPHANCY_AUDIT_ENABLED: booleanFromEnv.default(false),
  // ── AGI Level 6 Phase 15: 小模型增强 ────────────────────────────────
  // best-of-N 采样基数(按难度翻倍)。verifier 用 judge usage 打分选最优。
  BEST_OF_N_BASE: z.coerce.number().int().min(1).default(1),
  MEMORY_STALE_AFTER_DAYS: z.coerce.number().int().min(7).default(90),
  // ── AGI Level 4 P4-B: 好奇心目标追踪（常驻）───────────────────────────
  // 把「值得持续关注的事」固化为 goal，unified-tick 周期性 CodeAct 查进展并汇报。
  GOAL_MAX_ACTIVE: z.coerce.number().int().positive().default(20),
  // ── AGI Level 4 P4-C: 自我模型（常驻）────────────────────────────────
  // 每天凌晨复盘自己 24h 的回复表现 → ≤5 条自我认知注入回复 prompt。
  SELF_REFLECT_USAGE: z.string().default('judge'),
  // ── AGI Level 5 P5-A: 统一唤醒循环（常驻）───────────────────────────
  // 决策合并：一次 tick 一次 LLM 决定干什么（关心主人/群冒泡/自玩/查goal/安静），
  // 执行保留旧 cron 的执行器。已取代 idle/proactive-scan/thinker/self-play/goal-check。
  UNIFIED_TICK_INTERVAL_MIN: z.coerce.number().int().positive().default(5),
  UNIFIED_TICK_USAGE: z.string().default('judge'),
  UNIFIED_TICK_HOUR_START: z.coerce.number().int().min(0).max(23).default(8),
  UNIFIED_TICK_HOUR_END: z.coerce.number().int().min(0).max(23).default(23),
  // 两次 self-play 的最小间隔（tick 内 self_play 动作的冷却否决）
  SELF_PLAY_COOLDOWN_SEC: z.coerce.number().int().positive().default(4 * 3600),
  // （SCRATCHPAD_ENABLED 已移除——工作记忆常驻）
  // C:profile-merge 加频 —— 合并水位线间隔(小时)+ 每 tick 处理人数,调小/调大
  // 直接影响全局画像刷新频率与 token 消耗。
  PROFILE_MERGE_STALE_HOURS: z.coerce.number().int().positive().default(72),
  PROFILE_MERGE_MAX_UIDS: z.coerce.number().int().positive().default(8),
  // 每 tick 处理多少个"有 pending 消息"的用户画像。默认 20;调大可更快榨干
  // 积压的 pending backlog(有意义的真实工作),也提高 StepFun 消耗。
  PROFILE_SYNC_BATCH_SIZE: z.coerce.number().int().positive().default(20),
  // ── StepFun 配额消费引擎(用户选:滚动深反思)──────────────────────────
  // 专用后台引擎:持续对全量群做大窗口深反思 + 跨上下文画像合并,把 8000M/月订阅
  // 用起来(冲 ~100M/天)。默认关。日调用数 ≈ CALLS_PER_TICK × 1440(每分钟一 tick)。
  // 路由不在此配:群反思走 REFLECTION_USAGE、合并走 PROFILE_MERGE_USAGE(引擎复用
  // reflectChat/mergeGlobalProfile 各自的 usage,不做独立模型路由)。
  STEPFUN_CONSUMER_ENABLED: booleanFromEnv.default(false),
  STEPFUN_CONSUMER_CALLS_PER_TICK: z.coerce.number().int().positive().default(30),
  // 并发默认 4:StepFun 账号并发上限=8 且与用户可见的 reply/judge 共享,引擎须留余量
  // (设过高会 429 拖累实时回复)。
  STEPFUN_CONSUMER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // 群深反思在工作池里的权重(重复入池次数):群内容真实演化、最不浪费,给更高权重。
  STEPFUN_CONSUMER_REFLECT_WEIGHT: z.coerce.number().int().positive().default(3),
  // ── Mundo「难题攻坚」部门(可选,默认关)────────────────────────────────
  // 第三方自建端点上的深推理模型(qwen3.6/映射 Mundo AI),擅长硬算法/并发/调试,
  // 但延迟高、极耗 token、可能空转、端点自签证书不稳定 —— 只适合离线非关键任务且
  // 输出必须人工/对拍复核。关时零足迹;开时 `mundo` usage 可被显式路由(设某
  // AI_USAGE_X_LABEL=mundo,或 Redis 运行时路由覆盖),自带兜底链降级到可靠模型。
  MUNDO_ENABLED: booleanFromEnv.default(false),
  // 「深想」:群里 @bot / 回复 bot 的**硬技术问题**,正常回复照常,同时后台丢给
  // mundo 深推理,想好了补发一条「我仔细想了下:…」。只对直接问 + 廉价判定为硬技术
  // 的触发(低频),失败/回退/空则不补发(静默)。默认关;依赖 MUNDO_ENABLED。
  DEEP_THINK_ENABLED: booleanFromEnv.default(false),
  // P1-D gate 有状态化:把最近 5 次真实 LLM 决策注入 gate prompt(对齐 MaiBot
  // gate 与 planner 共享历史、看得到自己过往节奏判断)。
  TIMING_GATE_HISTORY_ENABLED: booleanFromEnv.default(false),
  // P2-E 解析失败方向:true = fail-closed 按 no_action 处理(MaiBot 语义:宁可
  // 沉默不插嘴;direct 已在上游 bypass;强债务转保护性 wait)。llm_call_failed
  // (网络)仍 fail-open。与仓库约定一致:行为变化默认关,.env 显式开。
  TIMING_GATE_FAIL_CLOSED: booleanFromEnv.default(false),
  // P2-F wait 到点回访时注入 [等待结束] 提示(仅 TURN_WAIT_RESUME_ENABLED 路径)。
  TIMING_WAIT_HINT_ENABLED: booleanFromEnv.default(false),

  // 心情/精力 → humanizer 参数调制 (Opus 评审: 随机性不该是 IID;
  // 累/被怼时回复更短更敷衍, 心情好时更活泼)。合并序: 群风格 < mood-tune <
  // 运营 override < ASI self-tune。
  MOOD_TUNE_ENABLED: booleanFromEnv.default(false),

  // 好感非对称动力学 (Opus 评审: 信任慢升快降 —— 伤害一次掉很多,
  // 修复要几十次正交互)。开启后正 delta × UP(慢), 负 delta × DOWN(快)。
  RELATIONSHIP_ASYMMETRY_ENABLED: booleanFromEnv.default(false),
  RELATIONSHIP_ASYMMETRY_UP: z.coerce.number().nonnegative().default(0.5),
  RELATIONSHIP_ASYMMETRY_DOWN: z.coerce.number().nonnegative().default(1.5),

  // 机制5: bot 自己的历史发言语义检索(Opus 评审: 翻旧账/自洽能力)。
  // 检索本群与当前话题相关的自发言, 作为独立参考块注入(不进 merged)。
  OWN_HISTORY_RETRIEVAL_ENABLED: booleanFromEnv.default(false),

  // unified-tick 熟面孔缺席检测(Opus 评审: 主动消息要有理由——
  // "想起某人三天没出现")。开启后世界状态会带 absentUsers,
  // 决策模型可选 remember_user 动作。
  UNIFIED_TICK_ABSENT_USERS_ENABLED: booleanFromEnv.default(false),

  // ── Turn Actor (MaiBot MaiSaka 式 per-chat 认知回合; docs/turn-actor/) ──
  // 全部默认关闭。关闭时 ingress/pipeline 行为与改造前完全一致。
  // G1: per-chat 回合 actor。开启后消息进 xxb:pending:{chatId}，由 turn job 统一消化。
  TURN_ACTOR_ENABLED: booleanFromEnv.default(false),
  // 灰度群列表（逗号分隔 chatId）。空 = TURN_ACTOR_ENABLED 时对所有 chat 生效。
  TURN_ACTOR_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n !== 0);
    }),
  // G3: 新消息打断在飞生成并带新上下文重规划。
  TURN_ABORT_ENABLED: booleanFromEnv.default(false),
  // 连续打断上限（MaiBot planner_interrupt_max_consecutive_count，默认 0=不打断；
  // 我们默认 2 —— 高速群里第二条新消息也应能掐死陈旧生成,review #6）。
  TURN_INTERRUPT_MAX_CONSECUTIVE: z.coerce.number().int().nonnegative().default(2),
  // 打断后静默期（毫秒），等这波消息发完再重规划（MaiBot 硬编码 1s）。
  TURN_INTERRUPT_QUIET_MS: z.coerce.number().int().nonnegative().default(1000),
  // 回合内内部轮次预算（reply + 自我接话 + 余量；MaiBot 是 10，保守起步）。
  TURN_MAX_INTERNAL_ROUNDS: z.coerce.number().int().positive().default(4),
  // G12 执行期互斥:runChatTurn 入口 per-chat Redis 锁,堵死"多生产者并发
  // scheduleTurn 造出双回合 → registerGeneration supersede 互杀 → replan
  // 预算白烧"的竞态(2026-07-04 诊断:毫秒级成对 replanning 实锤)。
  TURN_EXEC_LOCK_ENABLED: booleanFromEnv.default(false),
  TURN_EXEC_LOCK_TTL_MS: z.coerce.number().int().positive().default(120_000),
  // ── Agentic planner（MaiBot 1.0.0 Maisaka 多轮 plan→act 借鉴）──
  // 开了之后 planned 路径用 generateText({tools,maxSteps}) 原生工具循环,
  // 工具结果回写 LLM 历史,可自适应换工具/重查;失败自动回退旧 JSON 计划。
  PLANNER_AGENTIC_ENABLED: booleanFromEnv.default(false),
  // 循环步数上限（MaiBot MAX_INTERNAL_ROUNDS=10,工具场景 4 够用）。
  PLANNER_MAX_STEPS: z.coerce.number().int().positive().default(4),
  // SEND_IMAGE 工具(把上下文里的图转发出去,唯一有出站副作用的 agent 工具)。
  SEND_IMAGE_TOOL_ENABLED: booleanFromEnv.default(false),
  // ── 中期记忆(MaiBot 1.0.0 借鉴):ctx 滚出窗口前压缩成可引用摘要 ──
  MTM_ENABLED: booleanFromEnv.default(false),
  // 每轮压缩的最老消息条数
  MTM_CHUNK: z.coerce.number().int().positive().default(150),
  // 摘要 FIFO 上限(超出丢最老的)
  MTM_MAX_SUMMARIES: z.coerce.number().int().positive().default(10),
  // 压缩输入字符上限(防超长撑爆 summarize 模型)
  MTM_INPUT_MAX_CHARS: z.coerce.number().int().positive().default(16000),
  // G4: judge/gate/reply 以整个 burst 为决策单元（而非只看最后一条）。
  TURN_BURST_JUDGE_ENABLED: booleanFromEnv.default(false),
  // G5: wait 到期后带锚点重入回复路径（而非只解除屏蔽）。
  TURN_WAIT_RESUME_ENABLED: booleanFromEnv.default(false),
  // G7: 回访最近未回应的消息（注入 ≤2 条候选目标）。
  TURN_UNANSWERED_REVISIT_ENABLED: booleanFromEnv.default(false),
  // G2: 统一动作空间 planner（reply/react/sticker/silent/wait）。
  TURN_ACTION_PLANNER_ENABLED: booleanFromEnv.default(false),
  // G6: 发完后自我接话（"对了…"/补贴纸），新用户消息立即终止。
  TURN_SELF_FOLLOWUP_ENABLED: booleanFromEnv.default(false),
  TURN_SELF_FOLLOWUP_MAX: z.coerce.number().int().nonnegative().default(2),
  // G9: per-chat focus/能量标量（调制判断门槛、防抖、打字节奏）。
  TURN_FOCUS_ENABLED: booleanFromEnv.default(false),
  // G11: idle/proactive cron 经 turn actor 走完整人格管线。
  TURN_PROACTIVE_ENABLED: booleanFromEnv.default(false),
  // G8/S13 心流:L0 未命中的被动群消息,judge L1/L2 + gate 合并为一次
  // 带人格+自我状态的"心流判断"(reply/wait/pass)。1 次调用替代 1-3 次。
  HEART_ENABLED: booleanFromEnv.default(false),
  // 心流反思:仅在决定 reply 时,用**同一个** heart 模型把「念头」再磨一遍(更抓重点),
  // 不改决策(act/path)、不换模型;失败/超时保底用原念头。只在 reply 轮加一次调用。默认关。
  HEART_REFLECT_ENABLED: booleanFromEnv.default(false),
  // (旧名,弃用,留着防 .env 报错)
  TURN_UNIFIED_DECISION_ENABLED: booleanFromEnv.default(false),
  // gate no_action 冷却语义改向：冷却期内延后调度（MaiBot 拖时间），而非放行。
  TURN_GATE_DEFER_COOLDOWN: booleanFromEnv.default(false),
  // G13: 发送前反重复守卫（与自己最近消息相似度 > 阈值时带约束重生成一次）。
  ANTI_REPEAT_ENABLED: booleanFromEnv.default(false),
  ANTI_REPEAT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  // 多锚点:burst 按"发送者"分组,每组各自 judge→reply(flat 群里"线程"≈"人")。
  // 治"只回最后一条→像回错人":每人各自回,reply_to 自然指向那个人。单人
  // burst(groups.size===1)走原单锚点逻辑,零回归。
  TURN_MULTI_ANCHOR_ENABLED: booleanFromEnv.default(true),
  // 每回合最多回几个人(多锚点预算上限,direct 也算在内)。注意:多锚点会让
  // 单回合最多跑 N 次心流调用 + 发 N 条回复(L7 成本/速率),靠此值约束。
  TURN_MULTI_ANCHOR_MAX: z.coerce.number().int().positive().default(3),
  // per-person WAIT 抑制:wait 只抑制触发者集合(waitTriggerUids)的后续,别人
  // 照常进多锚点 judge。心流 wait 本意就是"等TA说完",抑制整群是过度抑制。
  // 同回合多人触发 wait → 都进集合,都被抑制(L1)。
  TURN_WAIT_PER_PERSON: booleanFromEnv.default(true),

  // ── Meta + Subagent (CyberGroupmate-shaped orchestration inside nyatbot) ──
  // 默认关。开启后灰名单群走 Attention→Meta→dispatch→CodeAct Subagent→callback,
  // 不再走 BullMQ message/turn-actor 直通(避免双回复)。详见 docs/meta-subagent/。
  META_SUBAGENT_ENABLED: booleanFromEnv.default(false),
  // 灰度 chatId 列表(逗号分隔)。空 = META_SUBAGENT_ENABLED 时对所有 chat 生效。
  META_SUBAGENT_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n !== 0);
    }),
  // Meta tick 间隔(ms)。对齐 CGM Attention flush 窗口量级。
  META_TICK_MS: z.coerce.number().int().positive().default(5000),
  /**
   * L0/L1 Attention 合并静默窗：群聊在最后一条进队后还要再等这么久才让 Meta flush。
   * 这是 Meta 路径的「连发→一回」节奏（不是 TIMING_TALK_VALUE / gate wait）。
   * L0 含昵称点名仍立刻 ingest；@ / 回 bot 可走 timing hard-bypass。
   * hold 到期会 kick 一次 metaTick，不完全依赖 META_TICK_MS。
   * 0 = 关闭。默认 2800ms。
   */
  META_L0_COALESCE_MS: z.coerce.number().int().nonnegative().default(2800),
  /**
   * Heart 插话不应期(ms)：bot 刚回过 / CodeAct 占用时，被动消息不再 elevate、也不再 auto-dispatch heart:。
   * 防群里同一话题连珠炮（三连赖账）。L0/@/回 bot 不受影响。0 = 关闭。默认 45s。
   */
  META_HEART_REFRACTORY_MS: z.coerce.number().int().nonnegative().default(45_000),
  /**
   * Meta 路径 defer 延迟重评：canDefer=true 传给 runTimingGate，让冷却/talk-value
   * 短路层产出 deferOnly 决策，再由 scheduleMetaDeferReeval 排 Redis ZSET 延迟重评，
   * 而非永久丢弃。需 TIMING_GATE_ENABLED + META_SUBAGENT_ENABLED 同开。默认关。
   */
  META_DEFER_ENABLED: booleanFromEnv.default(false),
  /**
   * Dispatch 期 timing gate：把 runTimingGate 挂到 CodeAct dispatch 前——
   * Heart/Meta 决定「说不说」，gate 决定「什么时候说」（老 pipeline 里
   * judge=REPLY 之后、reply 之前那道节奏闸的 meta 等价物）。
   * L0 direct / L1_CALLBACK bypass；其余（heart 插话、Meta LLM gap-fill
   * 闲聊）过完整短路层（continuation 免检 / 冷却 defer / talk-value）+ LLM。
   * 需 TIMING_GATE_ENABLED 同开；建议配合 META_DEFER_ENABLED。默认关。
   */
  META_DISPATCH_GATE_ENABLED: booleanFromEnv.default(false),
  /**
   * 承诺闭环（promise loop）：说出口的承诺必须落地——
   * ① telegram.sendToChat 跨群送达（仅主人 DM 任务，限 2 次/任务）；
   * ② goals.add 把「等下/回头要做的事」立成关注目标（unified-tick 到点执行）；
   * ③ endTask 兜底：bot 自己发的文本含承诺措辞但既没 goals.add 也没 sendToChat
   *    → 自动补立 goal（origin promise-backstop）。默认关。
   */
  PROMISE_LOOP_ENABLED: booleanFromEnv.default(false),
  // 承诺兜底判定用的 AI usage 名（便宜快模型；LLM 判定非规则引擎）。
  PROMISE_CHECK_USAGE: z.string().default('reflection'),
  /**
   * Post-Task Window（CGM 借鉴）：CodeAct 发完消息后开一个短暂发酵窗口，
   * 窗口内新消息由极轻量 LLM 判定「有没有人接住我刚才的话」，命中则不过
   * Meta 直接补一轮 CodeAct 回复。默认关。
   */
  POST_TASK_WINDOW_ENABLED: booleanFromEnv.default(false),
  // 发酵窗口时长(ms)。默认 2 分钟。
  POST_TASK_WINDOW_MS: z.coerce.number().int().positive().default(120_000),
  // follow-up 判定用的 AI usage 名（便宜快模型）。
  POST_TASK_FOLLOWUP_USAGE: z.string().default('judge'),
  /**
   * Session Digest 持久化（CGM 借鉴）：Meta/Subagent 每 session 的
   * [SESSION_DIGEST] 落 SQLite session_digests 表（FTS5 可检索），
   * 后续 session 按 delta 注入；Subagent 侧没输出 digest 不让 endTask。默认关。
   */
  DIGEST_PERSIST_ENABLED: booleanFromEnv.default(false),
  /**
   * Dreaming（CGM background-agent 简化版）：凌晨 cron 触发一个特权长任务，
   * 带着「上次做梦以来的任务/人/digest」素材自主行动（查资料/关心人/小工具）。
   * 默认关。
   */
  DREAMING_ENABLED: booleanFromEnv.default(false),
  // dreaming cron（UTC）。默认 19:17 UTC = 北京 03:17。
  DREAMING_CRON: z.string().default('17 19 * * *'),
  // dreaming 长任务用的 AI usage 名。
  DREAMING_USAGE: z.string().default('reply'),
  /**
   * Grounding 并行事实核查（CGM 借鉴）：heart/meta 决策的同时并行跑脱敏搜索，
   * 结果注入 CodeAct executor 作 grounding 参考；无搜索证据则丢弃。默认关。
   */
  GROUNDING_ENABLED: booleanFromEnv.default(false),
  // grounding 搜索综合用的 AI usage 名（便宜快模型）。
  GROUNDING_USAGE: z.string().default('judge'),
  /**
   * 关系评分量化（CGM 借鉴）：affinity 改由量化数据驱动——30 天窗口三维度
   * 百分位（互动次数/活跃天数/画像深度）+ LLM quality delta + 14 天衰减 +
   * Dunbar 容量上限（15/50/150 强制降级）。默认关（保持 LLM 直调旧行为）。
   */
  RELATIONSHIP_QUANT_ENABLED: booleanFromEnv.default(false),
  /**
   * tier 驱动画像精度：按关系 tier 裁剪 user_profiles（Tier1 traits≤10 留 14 天
   * episodes，Tier4 traits≤1 留 1 天）——不熟的人主动遗忘。默认关。
   */
  RELATIONSHIP_PROFILE_TRIM_ENABLED: booleanFromEnv.default(false),
  // 单次 Meta flush 最多处理几个 attention 条目。
  META_ATTENTION_TOP_N: z.coerce.number().int().positive().default(8),
  // Meta / CodeAct 用的 AI usage 名(走现有 AI_USAGE_* 路由)。
  META_USAGE: z.string().default('judge'),
  CODEACT_USAGE: z.string().default('reply'),
  // 画摊子（agent/artist.ts）的 AI usage 名：SVG 是代码活，默认跟 reply 主链。
  ARTIST_USAGE: z.string().default('reply'),
  CODEACT_MAX_TURNS: z.coerce.number().int().positive().default(8),
  CODEACT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // CodeAct BullMQ / local pump 全局并发；同 chat 仍串行（Redis active lock）。
  CODEACT_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // 长时间 Agent 循环：分段续跑 + checkpoint + 上下文压缩。默认关，灰度开。
  AGENT_LOOP_ENABLED: booleanFromEnv.default(false),
  // 单个任务最多跑几段（每段 CODEACT_MAX_TURNS 轮）。超限强制诚实收尾。
  AGENT_MAX_SEGMENTS: z.coerce.number().int().positive().default(10),
  // history 超过多少轮触发 LLM 压缩早期轮次。
  AGENT_COMPACT_AFTER_TURNS: z.coerce.number().int().positive().default(50),
  // 长任务进度可见性(P1):跨段续跑且从未发言时,每 10min 发一条"还在做"的
  // 确定性进度 ping(模型里程碑汇报不可靠 —— 能续跑的任务按定义从没 sendText 过)。
  AGENT_PROGRESS_PING_ENABLED: booleanFromEnv.default(false),
  // 上下文压缩用的 AI usage 名（便宜模型即可）。
  AGENT_COMPACT_USAGE: z.string().default('judge'),
  // Subagent host web.search（复用 pipeline executeSearch）。默认开；可关。
  CODEACT_WEB_SEARCH_ENABLED: booleanFromEnv.default(true),
  // Subagent host pixiv/linux.sb 只读工具。默认关，按灰度开。
  CODEACT_PIXIV_ENABLED: booleanFromEnv.default(false),
  CODEACT_LINUXSB_ENABLED: booleanFromEnv.default(false),
  // Context Engine:组装 Meta/Subagent prompt 时打 Manifest(可观测+稳定前缀)。
  CONTEXT_ENGINE_ENABLED: booleanFromEnv.default(true),
  // 日记 dream-journal(独立 flag,可不启 Meta 单独开)。
  DREAM_JOURNAL_ENABLED: booleanFromEnv.default(false),
  DREAM_JOURNAL_DIR: z.string().default('./data/dream-journal'),
  // 一个或多个 cron(UTC,逗号分隔)。默认:23:00 UTC=北京07:00(早)、15:00 UTC=北京23:00(睡前)。
  // 模型可 WRITE/SKIP；一天多段追加，无次数上限。也可用 sleep 边沿触发。
  DREAM_JOURNAL_CRON: z.string().default('0 23 * * *,0 15 * * *'),
  // 是否在硬作息起床/入睡边沿各试写一次(模型仍可 SKIP)。
  DREAM_JOURNAL_HOOK_SLEEP: booleanFromEnv.default(true),
  // 写完是否私聊推送给主人(MASTER_UID)。
  DREAM_JOURNAL_DM: booleanFromEnv.default(false),
  // 日记发布频道/群 chatId。正数会规范成 -100{id}(超群/频道)；0=不发频道。
  DREAM_JOURNAL_CHAT_ID: z.coerce.number().int().default(0),
  DREAM_JOURNAL_USAGE: z.string().default('reply'),
  // ── Silence Alert —— bot 沉默检测(端到端回复健康)──
  // 监控「最近有人类活跃但 bot 超阈值没回复」的 chat,告警到 owner DM。
  // 默认关;开时需配 SILENCE_ALERT_CHAT_ID(owner DM chatId)才真正发送,否则只打日志。
  SILENCE_ALERT_ENABLED: booleanFromEnv.default(false),
  // 扫描周期(分钟)。
  SILENCE_ALERT_INTERVAL_MIN: z.coerce.number().int().positive().default(5),
  // 告警目标(owner DM chatId,正数)。0=只打日志不发送。
  SILENCE_ALERT_CHAT_ID: z.coerce.number().int().default(0),
  // 人类最后发言距今超过该分钟数 = 不算活跃(潜水群不告警)。
  SILENCE_ALERT_HUMAN_STALE_MIN: z.coerce.number().int().positive().default(60),
  // bot 最后回复距今超过该分钟数 = 判定沉默。
  SILENCE_ALERT_THRESHOLD_MIN: z.coerce.number().int().positive().default(30),
  // 同一 chat 两次告警的最小间隔(去重,防刷屏)。
  SILENCE_ALERT_COOLDOWN_MIN: z.coerce.number().int().positive().default(120),
  // 单轮最多告警几个 chat(防告警风暴)。
  SILENCE_ALERT_MAX_PER_RUN: z.coerce.number().int().positive().default(5),
  // CodeAct 禁词(逗号分隔),出站文本命中则拒发并要求重写。
  CODEACT_BANNED_WORDS: z
    .string()
    .default('是吧,对吧,作为一个AI,作为人工智能')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),

  // ── Computer-use sandbox (Playwright + terminal) ──
  // ⚠️ 安全边界说明(2026-08-22 审查): computer.run 走宿主 /bin/sh -c 执行, 危险命令
  // 模式集(sandbox/terminal.ts)只是纵深防御——**不是**隔离。SANDBOX_ENABLED=true +
  // SANDBOX_TERMINAL_ENABLED=true 时模型可在宿主机执行任意未被模式命中的命令
  // (读 .env/网络外带)。真隔离需容器/独立 uid 运行 bot。
  SANDBOX_ENABLED: booleanFromEnv.default(false),
  SANDBOX_TERMINAL_ENABLED: booleanFromEnv.default(true),
  SANDBOX_BROWSER_ENABLED: booleanFromEnv.default(true),
  // Phase 15 真隔离: bwrap userns 沙盒默认开。设 0 回退宿主 exec(应急, 无隔离)。
  SANDBOX_BWRAP_ENABLED: booleanFromEnv.default(true),
  SANDBOX_ALLOWED_COMMANDS: z.string().default(''),
  SANDBOX_BLOCKED_COMMANDS: z.string().default('rm -rf,shutdown,reboot,mkfs,halt,dd if=,chmod 777'),

  // ── Learner (Expression + Jargon, Stage D) ──
  LEARNER_ENABLED: booleanFromEnv.default(false),
  LEARNER_SCAN_INTERVAL_MIN: z.coerce.number().int().positive().default(60),
  LEARNER_SCAN_USAGE: z.string().default('judge'),
  LEARNER_BATCH_SIZE: z.coerce.number().int().positive().default(80),
  LEARNER_MIN_NEW_MSGS: z.coerce.number().int().positive().default(30),
  LEARNER_MAX_CHATS_PER_TICK: z.coerce.number().int().positive().default(3),
  EXPRESSION_INJECT_ENABLED: booleanFromEnv.default(false),
  EXPRESSION_INJECT_COUNT: z.coerce.number().int().positive().default(5),
  // 口头禅自动惩罚闭环:盯 bot 自己发言,句首/句尾短语复读超阈值 → 自动降权 + 带 TTL
  // 动态拉黑(注入不喂回 + prompt 提示"少说")+ 到期自愈。默认关。
  TIC_PENALTY_ENABLED: booleanFromEnv.default(false),
  TIC_PENALTY_INTERVAL_MIN: z.coerce.number().int().positive().default(30),
  TIC_PENALTY_WINDOW: z.coerce.number().int().positive().default(60),        // 采样最近 N 条自发言
  TIC_PENALTY_MIN_MESSAGES: z.coerce.number().int().positive().default(4),   // 至少出现在几条里
  TIC_PENALTY_MIN_FRACTION: z.coerce.number().min(0).max(1).default(0.35),   // 至少占窗口比例
  TIC_PENALTY_TTL_SEC: z.coerce.number().int().positive().default(6 * 3600), // 动态拉黑存活时长
  // G1: 首档 4→3,黑话冷启动更快过推断线(重检计数修复后才有意义)
  JARGON_INFERENCE_THRESHOLDS: z.string().default('3,8,25,100'),
  JARGON_QUERY_ENABLED: booleanFromEnv.default(false),

  // ── P2-A: 主动搭话记忆驱动 ──
  // 主动发言时搜索 Qdrant 群聊记忆，注入"上次聊过的相关话题"
  PROACTIVE_MEMORY_ENABLED: booleanFromEnv.default(false),

  // ── P2-A: 主动搭话统一调度 ──
  // 防止 idle + proactive-scan 同时对同一群发消息；全局每群每小时上限
  PROACTIVE_COORDINATOR_ENABLED: booleanFromEnv.default(false),
  PROACTIVE_HOURLY_MAX_PER_CHAT: z.coerce.number().int().positive().default(3),

  // ── P2-B: RSS 信息流监控 ──
  // 周期轮询 RSS feeds，新条目存 Redis 供主动搭话引用
  RSS_MONITOR_ENABLED: booleanFromEnv.default(false),
  RSS_MONITOR_INTERVAL_MIN: z.coerce.number().int().positive().default(30),
  // JSON 数组: [{url, chatId, autoPost?, sourceName?}]
  RSS_FEEDS_JSON: z.string().default('[]'),
  // 自动发送时使用的 LLM 路由
  RSS_USAGE: z.string().default('summarize'),
  // 新条目新鲜度闸（小时）：pubDate 比阈值老的直接丢（仍计 seen 防回潮）；
  // 没日期/解析不了的放行（误杀比漏放糟）。2026-08-24：Opus 4.6 旧闻标题党被端上桌的教训。
  RSS_MAX_ITEM_AGE_HOURS: z.coerce.number().int().positive().default(72),

  // ── 天气环境感知（真人感）──
  // wttr.in 免费源，30min 缓存；注入 self-state / tick WorldState，全 fail-soft。
  WEATHER_ENABLED: booleanFromEnv.default(false),
  WEATHER_CITY: z.string().default('Beijing'),

  // ── 借力其他 bot(学其他 bot 的命令,需要时代发)──
  // P1:观察学习每个 bot 的命令档案(怎么用/场景/needs_reply/needs_admin/output_type)
  BOT_COMMAND_LEARN_ENABLED: booleanFromEnv.default(false),
  // 学习扫描间隔(分钟)
  BOT_COMMAND_LEARN_INTERVAL_MIN: z.coerce.number().int().positive().default(30),
  // 学习侧(把观察到的命令提炼成用法/场景)的 LLM 路由。离线 cron、不赶时间、是深
  // 推理任务 → 正好交给 mundo(qwen3.6);设 'mundo' 需 MUNDO_ENABLED。默认走 summarize。
  BOT_COMMAND_LEARN_USAGE: z.string().default('summarize'),
  // C 网络事件 burst:群里集体喊"挂了/CF炸了/502"时冒一句。reactive,默认关。
  NETWORK_BURST_ENABLED: booleanFromEnv.default(false),

  // A 多 bot 共存:对会话型 bot(千雪)/带媒体结果的工具 bot(解析姬)做反应。
  // reactive、不走 judge,自带 chat-lock + per-peer fatigue + 作息门。默认关。
  PEER_REACTION_ENABLED: booleanFromEnv.default(false),

  // D 选择性降噪:对 ad/verify/echo 类其他 bot 消息,跳过 judge/digest/学习
  //(保留进 ctx,不删)。依赖 BOT_CLASSIFIER_ENABLED 的 botClass。默认关。
  BOT_DENOISE_ENABLED: booleanFromEnv.default(false),

  // 入站 bot 消息分类层(A 多bot共存 / D 降噪 / 命令学习 的共用地基)。
  // 先 shadow:打标 + 日志,不改任何行为;精度够了再让 A/D 消费。
  BOT_CLASSIFIER_ENABLED: booleanFromEnv.default(false),

  // 合并写手:planned 路径用"一次带工具的写手调用"替代"planner 轮+写手"两段
  // (默认关,灰度;失败自动回退老两段路径)
  REPLY_MERGED_TOOLS_ENABLED: booleanFromEnv.default(false),
  // P3:direct(普通闲聊)路径也挂工具 —— 现状是 judge 判 direct 后写手完全无工具,
  // 群里随口问"这链接是啥/现在油价多少"只能瞎编。开启后 direct 也走合并写手,
  // 但只给只读子集(搜索/抓页/记忆/画像/历史/bot知识/黑话),不给 ADD_TIMER/
  // CREATE_POLL/USE_BOT_COMMAND 这类有副作用的,防闲聊途中误建投票定时器。
  // 前置依赖 REPLY_MERGED_TOOLS_ENABLED;不调工具时 ≈ 纯文本写手速度。
  REPLY_DIRECT_TOOLS_ENABLED: booleanFromEnv.default(false),
  REPLY_TOOLS_MAX_STEPS: z.coerce.number().int().min(2).max(6).default(4),

  // ── Multi-Agent 协调(Orchestrator + 专家 + Writer)──
  // 把"一个 agent 拿所有工具"拆成"几个专职专家并行 + Writer 收口"。
  // Router 复用 judge.replyPath(direct→chat 跳过专家,planned→lookup/deep 进专家),
  // 专家并行 fan-out,Writer 永远是唯一出口(persona 不分裂)。默认全开;灰度列表空=全群。
  MULTI_AGENT_ENABLED: booleanFromEnv.default(true),
  // 灰度群列表(逗号分隔 chatId)。空 = 对所有群生效;非空 = 仅列出的群走多智能体。
  MULTI_AGENT_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n !== 0);
    }),
  // 专家超时预算(与 turn 打断信号合并;超时→该专家 failed→Writer 回退内部 planner)
  MULTI_AGENT_RESEARCHER_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  MULTI_AGENT_RESEARCHER_MAX_STEPS: z.coerce.number().int().positive().default(6),
  // Phase 2 记忆员:agentic RECALL(语义记忆检索)专家,与研究员并行 fan-out。
  MULTI_AGENT_MEMORY_ENABLED: booleanFromEnv.default(true),
  // Phase 5 人设/关系专家:QUERY_PERSON_PROFILE + FETCH_HISTORY,搞清"在跟谁说、
  // 该用什么语气"。chat 路径也跑(默认),lookup/deep 并行 fan-out。
  MULTI_AGENT_PERSONA_ENABLED: booleanFromEnv.default(true),
  // 导演专家(写手前):读上下文+念头,产出"情绪/姿态/切入点"块喂写手。全路由并行。
  MULTI_AGENT_DIRECTOR_ENABLED: booleanFromEnv.default(true),
  MULTI_AGENT_DIRECTOR_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  // 上下文理解专家:忙群(最近消息数 ≥ 阈值)先把最近 N 条 digest 成"现在在聊啥"
  // 给写手,降写手 prompt 噪音 + 多吃一次 token。全路由并行。
  MULTI_AGENT_CONTEXT_DIGEST_ENABLED: booleanFromEnv.default(true),
  MULTI_AGENT_CONTEXT_DIGEST_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  MULTI_AGENT_CONTEXT_DIGEST_MIN_MSGS: z.coerce.number().int().positive().default(12),
  // chat 路径也跑记忆员+人设员+导演(direct 闲聊也带 grounding,多走 agentic、多吃 token;
  // 嫌延迟可关)。研究员/核查/Critic 仍只在 lookup/deep。
  MULTI_AGENT_CHAT_SPECIALISTS: booleanFromEnv.default(true),
  // Phase 3 核查员:核查研究员产出(lookup + deep 路径跑,有研究员素材才跑)。
  MULTI_AGENT_CHECKER_ENABLED: booleanFromEnv.default(true),
  MULTI_AGENT_CHECKER_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // Phase 4 Critic:草稿二审,不行回炉(deep 总是跑;lookup 默认关)。回炉轮数上限。
  MULTI_AGENT_CRITIC_ENABLED: booleanFromEnv.default(true),
  MULTI_AGENT_CRITIC_ON_LOOKUP: booleanFromEnv.default(false),
  MULTI_AGENT_CRITIC_MAX_ROUNDS: z.coerce.number().int().positive().default(2),
  MULTI_AGENT_CRITIC_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  // 人设一致性 Critic:每条回复都查"有没有叫错主人/破人设/破关系",有问题回炉 1 次。
  // 跟深度 Critic(查事实/跑题)分工:这个专攻人设/关系,全路由跑。
  MULTI_AGENT_PERSONA_CRITIC_ENABLED: booleanFromEnv.default(true),
  MULTI_AGENT_PERSONA_CRITIC_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),
  // Best-of-N 写手:生成 N 稿,选择器挑最贴的发。N=1 关闭。写手 token ×N。
  // 默认 1。best-of-N 对 direct 闲聊路由没有降级(orchestrator.ts:281),等于让一个
  // maxTokens:20 的小选择器在两条猫娘语气短句里挑一条,代价是写手 token ×2 —— 而写手是
  // 全链最贵的一次调用(5 层 system ≈ 19KB ≈ ~5k token + user turn ~3k)。需要多稿时按
  // 按需在具体群/场景提升,而不是全局常开。
  WRITER_BEST_OF_N: z.coerce.number().int().positive().default(1),
  WRITER_SELECTOR_ENABLED: booleanFromEnv.default(true),
  WRITER_SELECTOR_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),
  // 实时学习:每条回复后异步抽"这轮聊了啥/跟此人关系有没有变化"写 episode + 关系。
  // 替代部分批量 cron,记忆更鲜活。fire-and-forget,不阻塞回复。
  REALTIME_LEARN_ENABLED: booleanFromEnv.default(true),
  REALTIME_LEARN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // ASI 回复自评抽样率:1.0 = 全量(每条回复都自评),0.5 = 抽一半。
  // 默认 0.2。ASI rubric 与 realtime-learn 的回复自评对**同一对** (trigger, reply) 各打
  // 一次分,维度都是"贴人设/切题/自然度",是非设计意图的重复调用。两个 EMA 本来就是滚动
  // 平均,不需要全量样本。
  ASI_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.2),

  // P2:成熟后真正代发命令(USE_BOT_COMMAND 工具)。默认关 —— 没学够/没开就只"教用户"
  BOT_DELEGATION_ENABLED: booleanFromEnv.default(false),
  // 每群代发限速(秒):两次代发最小间隔
  BOT_DELEGATION_COOLDOWN_SEC: z.coerce.number().int().nonnegative().default(60),
  // 「调用路由」:@bot/回复bot 且意图明确匹配某条 ready 已学命令 → 专职廉价 LLM 判一次、
  // 命中就代发(脱离主回复模型的选工具)。保守触发、安全闸全在 tryDelegateCommand。默认关;
  // 依赖 BOT_DELEGATION_ENABLED。
  BOT_COMMAND_ROUTER_ENABLED: booleanFromEnv.default(false),

  // ── Sleep schedule(硬作息门):到点真睡觉,睡觉不闲聊,指令照常 ──
  // 直接交互(@/回 bot/私聊)走升级式吵醒,主人必醒;作息表沿用
  // life-state 的 date-seeded daySchedule(起床 07:00-08:30 / 入睡 23:30-01:00)
  SLEEP_SCHEDULE_ENABLED: booleanFromEnv.default(false),
  // 到点睡觉/起床时向最近活跃的群发晚安/早安(固定短句池,无 LLM)
  SLEEP_ANNOUNCE_ENABLED: booleanFromEnv.default(false),
  // 晚安时机守卫:就寝边沿若 bot 5 分钟内在活跃群说过话(对话中),推迟
  // 入睡相位 10 分钟,每晚最多 3 次 —— 治"自己刚回完话 50 秒就道晚安蒸发"。
  SLEEP_BEDTIME_GUARD_ENABLED: booleanFromEnv.default(false),

  // ── DM 好感主动私聊 (功能 B) ──
  // B1:睡前/起床给「已私聊过 bot 的高好感用户」发悄悄话(带跨群外号)。默认关。
  SLEEP_DM_ENABLED: booleanFromEnv.default(false),
  DM_GREET_AFFINITY_MIN: z.coerce.number().default(40),
  DM_GREET_MAX_USERS: z.coerce.number().int().default(2),       // 每个边沿最多几人
  DM_PROACTIVE_COOLDOWN_HOURS: z.coerce.number().default(20),    // 同人两次主动 DM 最小间隔
  // B3:群里@催pm(高好感但从没 DM)。最危险,默认关灰度。


  // 常驻贴纸包(逗号分隔的贴纸包 set_name):作为 bot 主力贴纸,选择时占多数候选槽。
  RESIDENT_STICKER_PACKS: z.string().optional(),

  // 控制指令(别理我/别理某人/可以说话了/记住X/忘掉X):typing 前用 LLM 听懂 →
  // 静默执行 + emoji ack,取代旧的 L0 关键词 regex。默认关。
  CONTROL_DIRECTIVE_ENABLED: booleanFromEnv.default(false),

  // ── Daily life / school schedule ──
  // 16 岁人设的「每日安排」：school=周课表，summer=暑假日计划，auto=7–8 月暑假否则上学。
  // SCHOOL_SCHEDULE_ENABLED 关 → 不注入。睡眠硬门仍优先于本模块。
  SCHOOL_SCHEDULE_ENABLED: booleanFromEnv.default(false),
  DAILY_LIFE_PROFILE: z.enum(['auto', 'school', 'summer']).default('auto'),

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

  // ── TTS voice messages (edge-tts, free local Python) ──
  // 把短回复概率性转成语音发送(适合短促亲昵/深夜私聊/情绪强烈的回复)。
  // edge-tts 生成 MP3 → ffmpeg 转 OGG/Opus(Telegram 语音消息要求 OggS+Opus)。
  // 全部默认关;开启需系统装好 `python3 -m edge_tts` 与 `ffmpeg`。
  TTS_ENABLED: booleanFromEnv.default(false),
  // edge-tts 语音名(中文默认晓晓;也可换 zh-CN-XiaoyiNeural 等)。
  TTS_VOICE: z.string().default('zh-CN-XiaoxiaoNeural'),
  // 每条满足条件的短回复转语音的概率(0..1)。
  TTS_VOICE_PROBABILITY: z.coerce.number().min(0).max(1).default(0.15),
  // 仅对不超过此字符数的回复转语音(长消息发语音很烦)。
  TTS_MAX_CHARS: z.coerce.number().int().positive().default(100),
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
   *  (如 kimi-k3 只允许 temperature=1,否则 400 invalid temperature)。 */
  temperature?: number;
  /** 声明是否支持图片输入(P2 多模态回复)。undefined=未知(照发,provider 自己拒);
   *  false=明确不支持(带图调用直接跳过该 label,不白烧一跳)。 */
  vision?: boolean;
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
    const fields = ['ENDPOINT', 'KEY', 'MODEL', 'FORMAT', 'STREAM', 'REASONING', 'THINKING', 'INSECURE', 'TIMEOUT', 'MAX_TOKENS', 'TEMPERATURE', 'RAW', 'VISION', 'TIER'] as const;
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
      temperature: (() => { const n = fields['TEMPERATURE'] ? parseFloat(fields['TEMPERATURE']) : NaN; return Number.isFinite(n) ? n : undefined; })(),
      vision: readBool(fields['VISION']),
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
