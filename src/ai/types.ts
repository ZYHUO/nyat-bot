// ────────────────────────────────────────
// AI 层类型定义
// ────────────────────────────────────────

export interface AILabel {
  name: string;
  endpoint: string;
  apiKeys: string[];
  model: string;
  stream?: boolean;
  apiFormat?: 'openai' | 'claude';
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  disableThinking?: boolean;
  /** 跳过 TLS 证书校验(仅限自建/自签证书端点;强制走 raw fetch + insecure dispatcher)。 */
  insecureTLS?: boolean;
  /** 强制走 raw fetch(而非 AI SDK generateText):裸路径对空/畸形响应返空不崩。 */
  forceRaw?: boolean;
  /** per-label 每次尝试超时(ms)覆盖 usage 超时(仍受调用方 maxTimeoutMs 上限约束)。 */
  timeout?: number;
  /** per-label maxTokens 覆盖(给推理模型放宽,防截断成空);调用方显式 maxTokens 优先。 */
  maxTokens?: number;
  /**
   * per-label temperature 强制覆盖(调用方显式值也让位):只接受固定温度的模型用
   * (如 kimi-k3 只允许 temperature=1)。
   *
   * round 12（新 goal）：**新增 `'omit'`** —— 这个 label 不要传 temperature 字段。
   *
   * 2026-09-22 实测 dshkimi（kimi-for-coding）：
   *   temperature=0    → 400 `invalid temperature: only 1 is allowed`
   *   temperature=0.7  → 403（连续调用触发限流，非参数问题）
   *   temperature=1    → 200，但**同一个 judge prompt 6 次里 1 次翻车**（reply×5/pass×1）
   *   不传该字段       → 200，同 prompt 6 次**全部一致**（reply×6），中位 4109ms
   *
   * 也就是说"只接受 1"不等于"必须传 1"——**省掉字段让它用服务端默认**，
   * 比强行传 1 更确定。round 9 我用"只接受 1 ⇒ judge 有 temperature=0 语义冲突"
   * 把它从确定性 usage 里排掉了，那个判断漏了"omit"这个选项。
   *
   * 为什么这重要：dshkimi 是池子里**唯一跨账号且够快**的 provider
   * （api.kimi.com，中位 4.1s）。排掉它之后 judge 只剩 api.stepfun.com 的
   * stepfun + step5 —— 单账号，账号级劣化会同时打中两个。
   */
  temperature?: number | 'omit';
  /**
   * 能力声明。undefined = 未知（**保留**，不因此排除——本仓库多数 provider
   * 没声明过，一律按"没声明"处理，只有显式 false 才排除）。
   *
   * video（2026-09-21）：能不能吃 `video_url` content part。**必须显式 true 才能
   * 进 video usage 的候选池**——因为"返回 200"不等于"看得懂"：实测 step-3.7-flash
   * 收下 video_url 但 content 为空（token 全烧在 reasoning 上）。不声明的一律
   * 不当视频供应商用。
   */
  capabilities?: { vision?: boolean; functionCalling?: boolean; video?: boolean };
  /** Smart Group auto-assign 质量分层: high=主力回复, medium=中等, low=廉价快。 */
  tier?: 'high' | 'medium' | 'low';
}

export interface AIUsage {
  label: string;
  backups: string[];
  timeout: number;
  maxTokens?: number;
  temperature?: number;
  /**
   * 该 usage 默认 JSON 输出（H4.2：stepfun 系吐脏 JSON 是系统性的——gate 529 次
   * parse_failed_closed、norms 6/9 首轮失败、tick 多周期连续 parse_failed 全同因）。
   * 开后 fallback 层自动带 jsonMode:true（provider 层转 response_format）。
   * 调用方可显式传 jsonMode:false 关掉（如 topic-scan 纯文本标签）。
   */
  jsonMode?: boolean;
}

export enum ModelTier {
  L0_RULE = 'L0_RULE',
  M1_MICRO = 'M1_MICRO',
  M2_FAST = 'M2_FAST',
  M3_MAIN = 'M3_MAIN',
}

export interface HedgeConfig {
  primaryLabel: string;
  hedgeLabel: string;
  hedgeDelayMs: number;
}

/** Multimodal content part for vision/audio models */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string; detail?: 'low' | 'high' | 'auto' } // data URL or URL; detail 默认 high(stepfun 识图需要)
  | { type: 'audio'; audio: string; format: string } // raw base64 (no data: prefix) + container format (wav/mp3/ogg/m4a)
  // 视频（2026-09-21）。data URL（含 base64）——**不要**用 Telegram 的 file URL，
  // 那个 URL 里带着 bot token，交给第三方等于泄密。
  // 只有部分供应商认这个 part（实测 step-5-preview 可以），所以走独立 `video` usage。
  | { type: 'video_url'; video_url: { url: string } };

export interface AICallOptions {
  usage: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>;
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  /**
   * External abort signal (e.g. turn-actor interrupt when new messages land
   * mid-generation). Merged with the per-label timeout signal; an abort here
   * surfaces as AIError code 'AI_ABORTED' and is NOT retried by the fallback
   * chain.
   *
   * 注意:不要把 AbortSignal.timeout(...) 烧进这个 signal —— 它会被 fallback
   * 链的**每一次**尝试复用,首跳超时后所有 backup 立刻 DOA(信号中毒)。
   * 想限定每次尝试的时长用 maxTimeoutMs。
   */
  signal?: AbortSignal;
  /**
   * Per-attempt wall-clock cap (ms). Caps the usage label's own timeout for
   * EACH attempt (primary / hedge / every backup) via the per-attempt
   * AbortSignal.timeout inside callModel, so a slow primary still leaves the
   * backups alive. Worst-case total wall-clock = attempts × min(usage.timeout,
   * maxTimeoutMs) — callers on latency-sensitive paths should keep this tight.
   */
  maxTimeoutMs?: number;
  /**
   * 全链都在冷却时，等最短的那个醒来再试一次。
   *
   * 2026-09-21 加。`callWithFallback` 默认只在**没有** maxTimeoutMs / signal 时才等
   * （那两条是延迟敏感路径的标志）。但后台批任务两者都设了——它们不怕等，
   * 却因此拿不到这个重试。实测 deep-reflection 02:44 一次 tick 15 个群全灭，
   * err 全是 `All labels exhausted (all candidates cooling down)`，而最短冷却只有十几秒。
   *
   * 后台任务显式传 true 覆盖那两条跳过条件。上界仍是 15s。
   */
  waitIfCooling?: boolean;
  /**
   * Skip LLM metrics emission for this call (llmEvents). Used by synthetic/diagnostic
   * traffic (e.g. cache warmup) so it doesn't pollute the per-usage metrics it's meant to observe.
   */
  suppressMetrics?: boolean;
  /**
   * Request strict JSON output. Two mechanisms, depending on the label's API format:
   *   · OpenAI-format raw path → `response_format: json_object` (needs "json" in the
   *     prompt for DeepSeek)
   *   · Claude-format (`/messages`) → an assistant message prefilled with `{`
   *     (Anthropic's documented prefill technique; the returned text has the brace
   *     stitched back on)
   *
   * 2026-09-21 之前这里只写了"openai-format raw path"，而 claude 分支根本不看这个
   * 参数——于是 `FORMAT=claude` 的 label（含 stepfun，judge/summarize 的默认主标签）
   * 上所有 jsonMode 调用都是静默无效：模型收到"请输出 JSON"的 prompt 却没有任何机制
   * 逼它，回散文，调用方 JSON.parse 失败。实测 dreaming 805 次 0% 产出就是这个病。
   *
   * 用法：**prompt 要求 JSON 且调用方会 parse 它，就该传 true。** 别依赖 usage 级
   * 配置——`reflection` usage 就没配，而 post-task-window 的 judge 要 parse JSON。
   */
  jsonMode?: boolean;
  /**
   * Treat an empty/blank model response as a failed attempt and continue the fallback chain.
   * Useful for low-frequency structured calls like heart/gate where an empty string is not
   * a meaningful success.
   */
  rejectEmpty?: boolean;
  /**
   * Set to false to disable the hedged request (primary+backup raced in parallel).
   * Hedging buys latency at 2x token cost — right for user-facing paths (reply/heart),
   * pure waste for fire-and-forget background batch (summarize/reflection/distill).
   */
  allowHedge?: boolean;
  /**
   * 归属会话,纯观测用途,不影响任何调用行为。透传进 llmEvents,让 social-ledger
   * 能把 LLM 调用摊到具体群上 —— "每回复几次调用"是 G8(合并人格决策)A/B 的
   * 核心成本指标,没有归属就只能看全局,而各群活跃度差异远大于 G8 本身的效应。
   * 不传的调用点(cron / 后台任务)不计入任何群。
   */
  chatId?: number;
}

export interface AICallResult {
  content: string;
  tokenUsage: { prompt: number; completion: number; total: number; cached?: number };
  model: string;
  label: string;
  latencyMs: number;
  fromCache?: boolean;
}
