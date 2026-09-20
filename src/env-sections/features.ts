// ────────────────────────────────────────
// env schema · features 段
// ────────────────────────────────────────
// 功能开关：StepFun 全网搜索、反广告行为气压、Silence Alert、Computer-use sandbox、Learner
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

export const featuresSection = {
  // ── StepFun 全网搜索（2026-09-20 起作为**主路由**）────────────────
  // 原 4 条 fallback 链（Gemini grounding / new-api grok / SearxNG / DDG）整体保留为
  // 后备，但默认走 stepfun 的 POST /v1/search：一次请求拿 title/snippet/content/time，
  // 不需要模型中转，比"让 Gemini 联网再总结"少一跳、也少一类工具标签泄漏面。
  // key 从 DSH 的 stepfun provider 取（HERMES_CUSTOM_API_STEPFUN_COM_API_KEY），
  // 不进任何日志。默认开；用 === false 关。
  STEPFUN_SEARCH_ENABLED: booleanFromEnv.default(true),
  STEPFUN_SEARCH_API_KEY: z.string().default(''),
  STEPFUN_SEARCH_BASE_URL: z.string().url().default('https://api.stepfun.com'),
  // stepfun 不认 max_results（恒返回 10 条），所以在客户端切。
  STEPFUN_SEARCH_MAX_RESULTS: z.coerce.number().int().positive().max(10).default(5),
  // 可选分类过滤：programming / research / gov / business。空 = 全网。

  // ── 反广告 · 行为气压（Ad Pressure）─────────────────────────────
  // 不是规则引擎：不做内容关键词匹配。宿主只测量"谁在以机器的方式刷屏"
  // （burst / echo / repeat / spread 四个行为信号，合成有界标量 adP），
  // 模型在 Frame 里看到事实后自己决定忽略/删/禁言/上报群主。
  // 默认全关；ANTIAD_CHAT_IDS 是群主白名单（= 群主授权），
  // 运行时也可用 Redis 键 xxb:trench:antiad:<chatId> 单独开/带 TTL 开。
  // 语料依据：本群生态里经典人类广告信号近乎为零（手机号 0 / 加密货币 0 /
  // 色情 0），真实噪声是其他 bot——所以按内容正则抓不到东西，按行为才抓得到。
  ANTIAD_ENABLED: booleanFromEnv.default(false),
  // 踢人（admin.kick）总闸。默认关。
  // 为什么单独一个 flag 而不跟 ANTIAD_ENABLED 绑：删消息/禁言可逆，踢人不可逆
  // （对方要自己加回来）。群主明确要"能踢"才开，且仍由模型按 Frame 里的事实决定。
  // 同时段对照基线采集 cron。默认开；它纯只读（只拍快照），关掉只会让
  // Phase 1 缺归判数据，不影响任何行为。=== false 关。
  CONTROL_BASELINE_ENABLED: booleanFromEnv.default(true),

  ANTIAD_KICK_ENABLED: booleanFromEnv.default(false),

  ANTIAD_CHAT_IDS: z.string().default('').transform((s) => {
    const t = s.trim();
    if (!t) return [] as number[];
    return t.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n !== 0);
  }),

  STEPFUN_SEARCH_CATEGORY: z.string().default(''),

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
  // Phase 15 真隔离: bwrap userns 沙盒默认开。
  SANDBOX_BWRAP_ENABLED: booleanFromEnv.default(true),
  // 隔离能力不可用时默认拒绝执行；仅在明确应急配置为 false 时允许宿主回退。
  SANDBOX_REQUIRE_ISOLATION: booleanFromEnv.default(true),
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
};
