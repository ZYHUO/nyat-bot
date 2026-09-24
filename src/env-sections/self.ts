// ────────────────────────────────────────
// env schema · self 段
// ────────────────────────────────────────
// 自我：好奇心目标、自我模型、统一唤醒循环、StepFun 配额消费引擎、Mundo 难题攻坚
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

export const selfSection = {
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

  // round 206: host sendText 日志里附全文（不只是 80 字 preview）。
  //
  // 为什么值得一个 flag：round 204 量到全文不在日志里（parts 是分片数、
  // preview 截断），于是"前言不搭后语"只能拿 40 字做单边判断。
  // round 205 量过成本：只给带 taskId 的发送加，每条约 360 字节、
  // 全日志 189 条 = 0.06 MB（现有 app.log 的 0.07%）。
  //
  // 为什么默认 OFF：不是怕花钱，是"改生产日志路径"本身要谨慎
  // （round 66：改坏了不会响）。验红覆盖"关时行为不变"。
  SEND_LOG_FULL_TEXT: booleanFromEnv.default(false),
};
