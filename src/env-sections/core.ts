// ────────────────────────────────────────
// env schema · core 段
// ────────────────────────────────────────
// Core v2 Phase 0（Belief View + 黑板 ACL + L2 permission gate）+ 小模型增强
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

export const coreSection = {
  // ── Core v2 Phase 0: Belief View + 黑板 ACL + L2 permission gate ──
  // 全部默认 OFF。Phase 0 是纯地基（新表+纯函数），不接任何主路径，
  // 开了也只影响 eval harness 和未来的 graylist 群。
  CORE_BELIEF_VIEW_ENABLED: booleanFromEnv.default(false),
  CORE_BLACKBOARD_ENABLED: booleanFromEnv.default(false),
  // L0 每消息留痕（core_blackboard kind='observation'）。
  // 2026-09-18 起默认 OFF：该 kind 没有任何读取方（`visibleToL1` 从未被调用），
  // 开着只会让 core_blackboard 累积无人消费的行。等真正的读取方落地再开。
  CORE_BLACKBOARD_OBSERVATIONS_ENABLED: booleanFromEnv.default(false),
  CORE_PERMISSION_GATE_ENABLED: booleanFromEnv.default(false),
  // Host-owned Agency rollout mode. The default keeps Core proposals observable
  // without allowing them to dispatch adapters or create external side effects.
  AGENCY_RUNTIME_MODE: z.enum(['shadow', 'advisory', 'canary', 'authority']).default('shadow'),
  AGENCY_CANARY_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isSafeInteger(n) && n !== 0);
    }),
  AGENCY_MAX_LLM_CALLS: z.coerce.number().int().min(0).max(100).default(2),
  AGENCY_MAX_TOOL_CALLS: z.coerce.number().int().min(0).max(100).default(8),
  AGENCY_FAIL_CLOSED: booleanFromEnv.default(true),
  // Explicit authority-only CodeAct queue binding. Shadow/advisory/canary keep
  // the legacy host path; authority rejects instead of silently bypassing it.
  AGENCY_CODEACT_TRANSPORT_ENABLED: booleanFromEnv.default(false),
  // Explicit authority-only Reply text binding. Authority failures never fall
  // back to legacy sender.sendDirect; keep the rollout opt-in.
  AGENCY_REPLY_TRANSPORT_ENABLED: booleanFromEnv.default(false),
  // Explicit authority-only wait/timing binding. Authority failures never
  // fall back to direct transitionToWait; keep the rollout opt-in.
  AGENCY_WAIT_TRANSPORT_ENABLED: booleanFromEnv.default(false),
  // Record successful legacy Reply deliveries as observed Agency outcomes.
  // This never dispatches or sends; keep it opt-in until the ledger is sized.
  AGENCY_LEGACY_REPLY_OBSERVATION_ENABLED: booleanFromEnv.default(false),
  // Durable perception/event log. Disable only for emergency rollback; callers
  // remain fail-soft when the migration is not present yet.
  COGNITIVE_EVENTS_ENABLED: booleanFromEnv.default(true),
  COGNITIVE_OUTBOX_ENABLED: booleanFromEnv.default(true),
  // Event-sourced NyatOS kernel shadow. It records one trigger/frame/action
  // chain but does not replace the legacy sender until a canary opts in.
  COGNITIVE_KERNEL_ENABLED: booleanFromEnv.default(false),
  // Kernel shadow graylist. Empty = all chats once the flag is on; set a few
  // internal chatIds so the first rollout stays measurable and bounded.
  COGNITIVE_KERNEL_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isSafeInteger(n) && n !== 0);
    }),
  // Close kernel actions whose dispatch budget expired after a crash. It only
  // writes terminal `interrupted` outcomes; it never re-sends a message.
  COGNITIVE_KERNEL_RECOVERY_ENABLED: booleanFromEnv.default(false),
  // Assemble the scoped cognitive workspace for legacy reply/Heart/Meta paths.
  // Keep it opt-in until latency and prompt-budget measurements are available.
  COGNITIVE_WORKSPACE_V2_ENABLED: booleanFromEnv.default(false),
  // Deterministic fast/deep/background routing telemetry. It is shadow-only
  // until a later rollout explicitly consumes the decision for behavior.
  COGNITIVE_ROUTING_ENABLED: booleanFromEnv.default(false),
  // Optional behavior rollout: deep Reply routes and signal-bearing background
  // ticks may opt into the scoped workspace. Empty chat list means all chats;
  // keep disabled by default.
  COGNITIVE_ROUTING_BEHAVIOR_ENABLED: booleanFromEnv.default(false),
  COGNITIVE_ROUTING_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isSafeInteger(n) && n !== 0);
    }),
  // Metadata-only group interaction expectations and host-observed social
  // prediction error. It never changes reply selection; keep rollout opt-in.
  SOCIAL_PREDICTION_ENABLED: booleanFromEnv.default(false),
  // Phase 1 SocialAct shadow: records the legacy judge's action contract only.
  // It never sends, changes reply selection, or stores message text. Empty chat
  // list means all chats once explicitly enabled.
  SOCIAL_ACT_SHADOW_ENABLED: booleanFromEnv.default(false),
  SOCIAL_ACT_SHADOW_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isSafeInteger(n) && n !== 0);
    }),
  // Event-backed mission/process continuity. It only emits durable wake and
  // checkpoint records; tools and Telegram side effects still need a separate
  // host-owned adapter/authority decision.
  COGNITIVE_CONTINUITY_ENABLED: booleanFromEnv.default(false),
  COGNITIVE_CONTINUITY_INTERVAL_SEC: z.coerce.number().int().min(15).default(60),
  // Host-side process wake execution. It only projects recent metadata and
  // checkpoints durable wakes; it does not grant authority or call an LLM.
  COGNITIVE_PROCESS_RUNTIME_ENABLED: booleanFromEnv.default(false),
  // Record what Telegram reports about a chat (title/type/username/description)
  // as host-observable world facts. This is the missing producer for
  // `world_change`: the projector already consumed that event type, but nothing
  // emitted it, so the World entity table stayed empty. Facts only, no inference.
  WORLD_FACTS_ENABLED: booleanFromEnv.default(false),
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
};
