// ────────────────────────────────────────
// env schema · turn 段
// ────────────────────────────────────────
// Turn Actor（MaiBot MaiSaka 式 per-chat 认知回合）+ Agentic planner + 中期记忆
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

export const turnSection = {
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

  // Nyat Trench Phase 1 旁路的**灰度群列表**。空 = 不旁路任何群（默认）。
  // 为什么需要灰度：翻旗的预期效果是把最忙群的发送率从 22% 抬到 86%（投影 3.9x），
  // 全量翻等于同时改所有群的行为，出了问题也分不清是哪群的什么条件触发的。
  // 按仓库既有约定（TURN_ACTOR_CHAT_IDS 同款）先开一个群，看金丝雀曲线再决定扩不扩。
  // 名单里的群走 bypass（心流不否决，消息仍按 layer 进 attention）。
  META_HEART_BYPASS_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n !== 0);
    }),
  // Nyat Trench Phase 1：Meta heart（meta/heart-adapter.ts）的旁路开关。
  // 它实测是实际做抑制的那层（12,009 次判定只放行 7.7%）；影子想 speak 85.6%。
  // false = 旁路它的 allow/silence，消息按既有 layer 分级直接进 attention。
  // 翻它之前必须先：envelope 已 enforce 且读过真实拦截率 + 金丝雀有对照基线。
  META_HEART_ENABLED: booleanFromEnv.default(true),  // 心流反思:仅在决定 reply 时,用**同一个** heart 模型把「念头」再磨一遍(更抓重点),
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
};
