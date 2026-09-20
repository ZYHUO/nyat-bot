// ────────────────────────────────────────
// env schema · judge 段
// ────────────────────────────────────────
// 定型判断基座 + 深度反思
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

export const judgeSection = {
  // ── 定型判断基座 src/ai/judge-substrate.ts ───────────────────────
  // bot 每天 ~45M token 大多花在"换回一个小决定"（gate 三选一、heart 说/等/不说、
  // shadow、judge）。这里把这类判断收敛到一个可插拔基座：typesafe 主后端，
  // 既有 chat LLM+JSON 兜底。三条底线：fail-open、DM/private 不走外部服务、可整体关掉。
  JUDGE_SUBSTRATE_ENABLED: booleanFromEnv.default(false),
  JUDGE_SUBSTRATE_BACKEND: z.string().default('typesafe'), // typesafe | chat
  JUDGE_SUBSTRATE_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  JUDGE_SUBSTRATE_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(120000),
  JUDGE_SUBSTRATE_BREAKER_FAILS: z.coerce.number().int().positive().default(3),
  JUDGE_SUBSTRATE_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(60000),
  TIMING_GATE_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  // gate LLM 的 max_tokens。
  //
  // 2026-09-21 修：这里原来是**调用点写死的 200**，而 gate 的 usage 现在是
  // `reflection` → stepfun = step-3.7-flash，一个 **reasoning 模型**，
  // reasoning_content 计入 completion。实测同一个 gate prompt：
  //   maxTokens=200  → content 为空（completion=200，finish_reason=length）
  //   maxTokens=800  → 合法 JSON
  //   maxTokens=2000 → 合法 JSON
  // 于是 324 次调用里 199 次（61%）"parse failed" —— 不是模型吐脏 JSON，
  // 是它**根本没来得及吐**。失败走 fail-closed no_action，看起来像"gate 判了
  // 不说话"，实际是"gate 被截断了于是闭嘴"。env.ts 上面那条注释把 61% 记成
  // "实测依据"放了很久，没人去修。
  //
  // 1200 是按实测留的余量：合法 JSON 只要 ~260 completion token。
  TIMING_GATE_MAX_TOKENS: z.coerce.number().int().positive().default(1200),
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
};
