// ────────────────────────────────────────
// env schema · social 段
// ────────────────────────────────────────
// 社交与借力：主动搭话、RSS 监控、天气感知、其他 bot 命令学习、Multi-Agent 协调
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

export const socialSection = {
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
  // Route-convergence experiment: for an explicit allowlist, direct/fast
  // replies stop spawning chat specialists; deep/lookup keep only work
  // justified by their route. Default remains legacy.
  MULTI_AGENT_ROUTE_CONVERGENCE_ENABLED: booleanFromEnv.default(false),
  MULTI_AGENT_ROUTE_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t.split(',').map((x) => Number(x.trim())).filter((n) => Number.isSafeInteger(n) && n !== 0);
    }),
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
  // ASI rubric 走哪个 usage。
  //
  // 2026-09-21：原来硬编码 'judge'，而 judge 的 label 是 FORMAT=claude 的 stepfun
  // → 走 callClaude（Anthropic /messages），**不吃 response_format**。模型于是回
  // 中文 markdown 评语而不是 JSON，parseRubric 找不到 `{}` → 回落到中性默认值。
  // 实测库里 2070 行一模一样 (0.5,0.5,0.5,0.5,0.2,77.0)——rubric 从来没测到过。
  //
  // StepFun 的同一个 /step_plan/v1 也提供 /chat/completions（OpenAI 兼容），
  // 那条路吃 response_format：实测带 json_object + max_tokens=1200 直接返回
  // {"social_presence":0.9,...}。所以这里配一个**同厂同模型、OpenAI 格式**的
  // label（AI_PROVIDER_STEPFUNASI_*，不设 FORMAT），让这条调用走裸路径。
  ASI_USAGE: z.string().default('asi'),
  // rubric 的 max_tokens。step-3.7-flash 是 reasoning 模型，思维链计入 completion：
  // 实测 120/600 都只拿到空 content，1200 才出正文。别改小。
  ASI_RUBRIC_MAX_TOKENS: z.coerce.number().int().positive().default(1200),

  // P2:成熟后真正代发命令(USE_BOT_COMMAND 工具)。默认关 —— 没学够/没开就只"教用户"
  BOT_DELEGATION_ENABLED: booleanFromEnv.default(false),
  // 每群代发限速(秒):两次代发最小间隔
  BOT_DELEGATION_COOLDOWN_SEC: z.coerce.number().int().nonnegative().default(60),
  // 回复式代发(bots.command 带 replyToMessageId):让别的 bot 代罚。
  // 默认开——它比 admin.kick 更窄:只能发"必须回复某条消息才生效"且学熟
  // (needs_reply=1 / needs_admin=0 / status=ready)的命令,且与 admin.kick
  // **共用同一把钥匙**(ANTIAD_KICK_ENABLED 或该群已授权反广告)。群主没要反广告
  // 时这个开关开着也一条都发不出去。当前档案里合法的那条就是 nmnmfunbot /spam。
  BOT_REPLY_DELEGATION_ENABLED: booleanFromEnv.default(true),
  // 两次回复式代发最小间隔(秒)。群管动作连着来就像机器在干活。
  BOT_REPLY_DELEGATION_COOLDOWN_SEC: z.coerce.number().int().nonnegative().default(60),
  // 每群每小时回复式代发上限。超过就只观察不动手。
  BOT_REPLY_DELEGATION_MAX_PER_HOUR: z.coerce.number().int().nonnegative().default(3),
  // 「调用路由」:@bot/回复bot 且意图明确匹配某条 ready 已学命令 → 专职廉价 LLM 判一次、
  // 命中就代发(脱离主回复模型的选工具)。保守触发、安全闸全在 tryDelegateCommand。默认关;
  // 依赖 BOT_DELEGATION_ENABLED。
  BOT_COMMAND_ROUTER_ENABLED: booleanFromEnv.default(false),
};
