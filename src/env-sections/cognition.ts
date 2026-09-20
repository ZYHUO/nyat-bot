// ────────────────────────────────────────
// env schema · cognition 段
// ────────────────────────────────────────
// 认知层 AGI Level 4/5/6：经验沉淀、自我技能、爱好、经验验证、Dreaming、长期任务、证据门、Loop 策略、多智能体共享、世界状态、context rot、群体风格、ToM、记忆陈旧、Task 架构、反向阀门
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

export const cognitionSection = {
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
};
