// ────────────────────────────────────────
// env schema · meta 段
// ────────────────────────────────────────
// Meta + Subagent（CyberGroupmate 形态的编排层）
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

export const metaSection = {
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
  // （DREAMING_USAGE 2026-09-21 删除：全仓库（src/scripts/packages/tests，含 .sh）无一处读取。dreaming 长任务实际用的 usage 在 cron 里另取，这个键从未被读）
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
  // （CODEACT_MAX_TURNS 2026-09-21 删除：全仓库（src/scripts/packages/tests，含 .sh）无一处读取。每段轮数上限是 executor.ts 里写死的 30，不是这个 8）
  CODEACT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  // CodeAct BullMQ / local pump 全局并发；同 chat 仍串行（Redis active lock）。
  CODEACT_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // 长时间 Agent 循环：分段续跑 + checkpoint + 上下文压缩。默认关，灰度开。
  AGENT_LOOP_ENABLED: booleanFromEnv.default(false),
  // 长任务用户可见阶段通知：运行时负责短确认/保活，失败不影响任务执行。
  TASK_PROGRESS_ENABLED: booleanFromEnv.default(true),
  TASK_PROGRESS_MIN_INTERVAL_MS: z.coerce.number().int().nonnegative().default(30_000),
  TASK_PROGRESS_MAX_VISIBLE_UPDATES: z.coerce.number().int().positive().default(6),
  // （TASK_PROGRESS_START_DELAY_MS 2026-09-21 删除：全仓库（src/scripts/packages/tests，含 .sh）无一处读取。task-progress.ts 的节流只读 KEEPALIVE/MIN_INTERVAL，没有起始延迟这个概念）
  TASK_PROGRESS_KEEPALIVE_MS: z.coerce.number().int().positive().default(35_000),
  // （TASK_PROGRESS_CODEACT_ENABLED / TASK_PROGRESS_RESEARCH_ENABLED 2026-09-21 删除：
  //   两个都默认 true 而全仓库无一处读取。task-progress.ts 只读 TASK_PROGRESS_ENABLED，
  //   这两个"按任务类型分开控制"的旋钮从未接上。）
  // 认知债务后台扫描（CSR）：过期清理 + 到期债务记录 + 预测误差摘要。默认关，灰度开。
  DEBT_SWEEP_ENABLED: booleanFromEnv.default(false),
  DEBT_SWEEP_INTERVAL_MIN: z.coerce.number().int().positive().default(30),
  // Durable cognitive event projection is safe to run without authority; debt
  // creation remains a separate opt-in until its false-positive rate is known.
  DEBT_AUTO_MATCH_ENABLED: booleanFromEnv.default(false),
  // Optional host-owned semantic ranking after deterministic debt matching.
  // It never resolves debt and is deliberately off until cost/quality is measured.
  DEBT_SEMANTIC_MATCH_ENABLED: booleanFromEnv.default(false),
  DEBT_SEMANTIC_MATCH_USAGE: z.string().default('judge'),
  DEBT_SEMANTIC_MATCH_MAX_CANDIDATES: z.coerce.number().int().min(0).max(32).default(4),
  DEBT_SEMANTIC_MATCH_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.72),
  DEBT_SEMANTIC_MATCH_TIMEOUT_MS: z.coerce.number().int().positive().max(10_000).default(2_500),
  // LLM group-norm proposals do not mutate the durable hypothesis by default;
  // verified host evidence uses the separate evidence-gated updater.
  GROUP_NORMS_AUTO_UPDATE_ENABLED: booleanFromEnv.default(false),

  // 回复形态与安全分段：先灰度控制，关闭时保留旧回复路径。
  // （REPLY_MODE_ENABLED / REPLY_ACK_THEN_EXPAND_ENABLED / REPLY_MICRO_REACTION_MAX_CHARS /
  //   REPLY_ACK_MAX_CHARS / REPLY_MAX_EXPANSION_SEGMENTS 2026-09-21 删除：
  //   "回复形态与安全分段"这一整个特性既没接也没实现，五个旗标全是无人读的摆设，
  //   其中两个还默认 true——看着像在跑。要做就当真功能做，别翻旧开关。）
  REPLY_LONG_TEXT_SAFE_SPLIT_ENABLED: booleanFromEnv.default(true),
  REPLY_HUMANIZER_SAFE_MODE: booleanFromEnv.default(true),

  // 单个任务最多跑几段（每段 CODEACT_MAX_TURNS 轮）。超限强制诚实收尾。
  AGENT_MAX_SEGMENTS: z.coerce.number().int().positive().default(10),
  // 单个任务**一共**最多发几条消息（跨段累计）。
  // 2026-09-21 之前这个预算实际是"每段 6 条 × 10 段 = 60 条"——每段重建 host api
  // 就把 textSent 归零了。实测 1555 个任务/2965 次投递，最差一个 46 秒 12 条。
  // 默认 6 = 与原来的单段上限一致：单段内行为不变，只把跨段累计那条口子堵上。
  AGENT_TASK_SEND_BUDGET: z.coerce.number().int().nonnegative().default(6),
  // history 超过多少轮触发 LLM 压缩早期轮次。
  AGENT_COMPACT_AFTER_TURNS: z.coerce.number().int().positive().default(50),
  // （AGENT_PROGRESS_PING_ENABLED 2026-09-21 删除：全仓库无一处读取，.env 里开着。
  //   它描述的"确定性进度 ping"从未实现——真要做是个新功能，不是翻一个旧开关。）
  // 上下文压缩用的 AI usage 名（便宜模型即可）。
  AGENT_COMPACT_USAGE: z.string().default('judge'),
  // Subagent host web.search（复用 pipeline executeSearch）。默认开；可关。
};
