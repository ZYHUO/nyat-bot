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
  XAI_SEARCH_MODEL: z.string().default('grok-4-0709'),
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
    .default('xxb,啾咪囝')
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
  ALLOWLIST_AI_AUTO_ENABLE: booleanFromEnv.default(true),
  ALLOWLIST_AI_CONFIDENCE_THRESHOLD: z.coerce.number().default(0.85),

  // ── Proactive Engagement (Stage B) ──
  JUDGE_PROACTIVE_ENABLED: booleanFromEnv.default(false),
  JUDGE_PROACTIVE_RATE: z.coerce.number().min(0).max(1).default(0.25),
  JUDGE_PROACTIVE_MIN_INTERVAL_SEC: z.coerce.number().int().positive().default(120),
  JUDGE_PROACTIVE_MIN_RECENT_MSGS: z.coerce.number().int().positive().default(3),

  // ── Proactive Scan Cron (Stage C) ──
  PROACTIVE_SCAN_ENABLED: booleanFromEnv.default(false),
  PROACTIVE_SCAN_INTERVAL_MIN: z.coerce.number().int().positive().default(5),
  PROACTIVE_SCAN_USAGE: z.string().default('judge'),
  PROACTIVE_SCAN_MIN_INTERVAL_SEC: z.coerce.number().int().positive().default(900),
  PROACTIVE_SCAN_MAX_CHATS_PER_TICK: z.coerce.number().int().positive().default(3),
  // Attention pressure(借鉴 CGM):主动扫群按 pressure 排序挑 Top-N,而非随机。默认关。
  PROACTIVE_PRESSURE_ENABLED: booleanFromEnv.default(false),
  // 到点提醒唤醒 LLM(用群里上下文、自己的语气说),而非念稿「⏰定时提醒:X」。默认关。
  SCHEDULE_LLM_WAKE: booleanFromEnv.default(false),
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
  // no_action 指数退避(MaiBot 借鉴):窗口 = base * 2^max(0, n-START),
  // 即第 START_COUNT+1 次 no_action 起开始翻倍,封顶 CAP;continue/真实
  // 回复清零计数。
  NO_ACTION_BACKOFF_START_COUNT: z.coerce.number().int().nonnegative().default(2),
  NO_ACTION_BACKOFF_CAP_SEC: z.coerce.number().int().positive().default(300),

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
  // (旧名,弃用,留着防 .env 报错)
  TURN_UNIFIED_DECISION_ENABLED: booleanFromEnv.default(false),
  // gate no_action 冷却语义改向：冷却期内延后调度（MaiBot 拖时间），而非放行。
  TURN_GATE_DEFER_COOLDOWN: booleanFromEnv.default(false),
  // G13: 发送前反重复守卫（与自己最近消息相似度 > 阈值时带约束重生成一次）。
  ANTI_REPEAT_ENABLED: booleanFromEnv.default(false),
  ANTI_REPEAT_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),

  // ── Learner (Expression + Jargon, Stage D) ──
  LEARNER_ENABLED: booleanFromEnv.default(false),
  LEARNER_SCAN_INTERVAL_MIN: z.coerce.number().int().positive().default(60),
  LEARNER_SCAN_USAGE: z.string().default('judge'),
  LEARNER_BATCH_SIZE: z.coerce.number().int().positive().default(80),
  LEARNER_MIN_NEW_MSGS: z.coerce.number().int().positive().default(30),
  LEARNER_MAX_CHATS_PER_TICK: z.coerce.number().int().positive().default(3),
  EXPRESSION_INJECT_ENABLED: booleanFromEnv.default(false),
  EXPRESSION_INJECT_COUNT: z.coerce.number().int().positive().default(5),
  // G1: 首档 4→3,黑话冷启动更快过推断线(重检计数修复后才有意义)
  JARGON_INFERENCE_THRESHOLDS: z.string().default('3,8,25,100'),
  JARGON_QUERY_ENABLED: booleanFromEnv.default(false),

  // ── Idle proactive cron (group has been silent → poke) ──
  // Bot 在群沉默超过 N 秒后，以 P 概率主动发一句活跃群聊。
  // 同一群两次主动开口的最小间隔（默认 24h，一天最多 1 次）
  IDLE_PROACTIVE_INTERVAL_SEC: z.coerce.number().int().positive().default(86400),
  IDLE_THRESHOLD_SEC: z.coerce.number().int().positive().default(3600),
  IDLE_TRIGGER_PROBABILITY: z.coerce.number().min(0).max(1).default(0.1),
  IDLE_HOUR_START: z.coerce.number().int().min(0).max(23).default(10),
  IDLE_HOUR_END: z.coerce.number().int().min(0).max(23).default(23),

  // ── 借力其他 bot(学其他 bot 的命令,需要时代发)──
  // P1:观察学习每个 bot 的命令档案(怎么用/场景/needs_reply/needs_admin/output_type)
  BOT_COMMAND_LEARN_ENABLED: booleanFromEnv.default(false),
  // 学习扫描间隔(分钟)
  BOT_COMMAND_LEARN_INTERVAL_MIN: z.coerce.number().int().positive().default(30),
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
  REPLY_TOOLS_MAX_STEPS: z.coerce.number().int().min(2).max(6).default(4),

  // P2:成熟后真正代发命令(USE_BOT_COMMAND 工具)。默认关 —— 没学够/没开就只"教用户"
  BOT_DELEGATION_ENABLED: booleanFromEnv.default(false),
  // 每群代发限速(秒):两次代发最小间隔
  BOT_DELEGATION_COOLDOWN_SEC: z.coerce.number().int().nonnegative().default(60),

  // ── Sleep schedule(硬作息门):到点真睡觉,睡觉不闲聊,指令照常 ──
  // 直接交互(@/回 bot/私聊)走升级式吵醒,主人必醒;作息表沿用
  // life-state 的 date-seeded daySchedule(起床 07:00-08:30 / 入睡 23:30-01:00)
  SLEEP_SCHEDULE_ENABLED: booleanFromEnv.default(false),
  // 到点睡觉/起床时向最近活跃的群发晚安/早安(固定短句池,无 LLM)
  SLEEP_ANNOUNCE_ENABLED: booleanFromEnv.default(false),

  // ── DM 好感主动私聊 (功能 B) ──
  // B1:睡前/起床给「已私聊过 bot 的高好感用户」发悄悄话(带跨群外号)。默认关。
  SLEEP_DM_ENABLED: booleanFromEnv.default(false),
  DM_GREET_AFFINITY_MIN: z.coerce.number().default(40),
  DM_GREET_MAX_USERS: z.coerce.number().int().default(2),       // 每个边沿最多几人
  DM_PROACTIVE_COOLDOWN_HOURS: z.coerce.number().default(20),    // 同人两次主动 DM 最小间隔
  // B3:群里@催pm(高好感但从没 DM)。最危险,默认关灰度。
  PM_NUDGE_ENABLED: booleanFromEnv.default(false),
  PM_NUDGE_AFFINITY_MIN: z.coerce.number().default(45),          // 较高门槛(用户要求达高好感才主动)
  PM_NUDGE_MIN_INTERACTIONS: z.coerce.number().int().default(20),
  PM_NUDGE_MAX_ATTEMPTS: z.coerce.number().int().default(3),     // 三家建议≤3
  PM_NUDGE_INTERVAL_DAYS: z.string().default('3,5,7'),           // 递增间隔
  PM_NUDGE_GLOBAL_DAILY_MAX: z.coerce.number().int().default(2), // 全局每日主动@上限(防封号生命线)
  PM_NUDGE_EXHAUST_PENALTY: z.coerce.number().default(15),       // 催满未果扣好感
  PM_NUDGE_COOLDOWN_DAYS: z.coerce.number().default(30),         // exhausted 后冷却

  // 常驻贴纸包(逗号分隔的贴纸包 set_name):作为 bot 主力贴纸,选择时占多数候选槽。
  RESIDENT_STICKER_PACKS: z.string().optional(),

  // 控制指令(别理我/别理某人/可以说话了/记住X/忘掉X):typing 前用 LLM 听懂 →
  // 静默执行 + emoji ack,取代旧的 L0 关键词 regex。默认关。
  CONTROL_DIRECTIVE_ENABLED: booleanFromEnv.default(false),

  // ── School schedule (功能 A) ──
  // 16 岁上学人设:确定性周课表 + school_overrides 特殊日,注入 self-state。
  // 默认关。睡眠硬门优先级高于上课。
  SCHOOL_SCHEDULE_ENABLED: booleanFromEnv.default(false),

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
