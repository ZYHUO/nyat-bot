// ────────────────────────────────────────
// env schema · timing 段
// ────────────────────────────────────────
// Timing Gate（MaiBot 式：去抖 + 状态机 + LLM gate + talk-value + continuation）
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

export const timingSection = {
  // ── Timing Gate (MaiBot-style: debounce + state machine + LLM gate) ──
  // 全局开关。关闭时所有 timing 模块退化为透传，行为等价于改造前。
  TIMING_GATE_ENABLED: booleanFromEnv.default(false),

  // gate 的 LLM 分支开关。false = 所有确定性层原样保留，走到 LLM 之前直接 continue。
  // 实测依据：324 次调用 199 次解析失败(61%)，成功里 124/125 是 no_action
  // （理由清一色同一条规则的改写）。token 占比仅 ~0.2%，省 token 不是理由。
  TIMING_GATE_LLM_ENABLED: booleanFromEnv.default(true),
  // 阶段 1：消息去抖窗口（毫秒）。0 = 关闭去抖。
  // 同一 chat 内，新消息会重置定时器；超过 MAX_BUFFER_MS 强制 flush 防止饥饿。
  TIMING_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(2000),
  TIMING_DEBOUNCE_MAX_BUFFER_MS: z.coerce.number().int().nonnegative().default(8000),
  // 阶段 2：ChatRuntime 状态过期时间（秒）。超过则视作 STOP 默认状态。
  TIMING_STATE_TTL_SEC: z.coerce.number().int().positive().default(86400),
  // 阶段 3：Timing Gate LLM usage label。默认走 judge usage（小模型）。
  TIMING_GATE_USAGE: z.string().default('judge'),
  // 确定性前置检查：烧 LLM 之前先判定"这条明显是群友之间在聊、与 bot 无关"。
  // 依据 2026-09-18 实测：gate 的 LLM 分支 121/122 给出同一个 no_action，
  // 理由全部命中 timing-gate.md 里那条显式规则（"群友彼此在聊 → 别硬挤"）。
  // 保守设计：只在结构完全明确时短路，模糊情况仍交给 LLM（失败方向是多烧一次，不是丢回复）。
  TIMING_GATE_PRECHECK_ENABLED: booleanFromEnv.default(false),
  // 冷却作为"事实"交给模型，而不是静默丢弃。
  // 旧行为把决定权从模型拿走，且 dispatch gate 还会再拦一次——
  // 而 heart 的 LLM 调用已经烧掉了（实测 6h 内 68 次 cooldown 短路发生在
  // heart 决定 reply 之后）。开=模型自己掂量；关=旧的静默丢弃。
  HEART_COOLDOWN_AS_FACT: booleanFromEnv.default(false),
  // heart 已经带事实做过时机判断（它自己就是 gate）→ 派发前不再重复过闸。
  // 实测 6h 内 68 次 cooldown + 38 次 talk-value 短路发生在 heart 决定 reply
  // 之后 = 那次 heart 调用白烧。开=模型自己控制；关=旧的双闸行为。
  HEART_DECIDES_TIMING: booleanFromEnv.default(false),
  // 关系修复：把"我说了句没讨好的话、之后没再提"作为事实交给模型，
  // 由它决定要不要回去说点什么。宿主只呈现，不代发、不自动道歉。
  // 触发信号已存在（outcome.ts 的 explicit_negative / repair_loop → 'corrected'），
  // 但此前没有消费方（action-board 的 repair 动作有定义、无生产者）。
  REPAIR_ENABLED: booleanFromEnv.default(false),
  // 主动发言意愿闸（reward model）：主动开口前用一次便宜的 judge 判断
  // "现在发这句话合不合适"。原作者注释：取代扁平概率、针对主动 bot 的
  // 头号失败模式（不合时宜地打断）。fail-OPEN：闸门故障绝不让 bot 变哑。
  // 此前硬编码 true 但零调用方；2026-09-19 接进 unified-tick 的 4 个主动发送点。
  REWARD_GATE_ENABLED: booleanFromEnv.default(false),
  // 回收超期未验证的 skill 提案（proposed > 30d → rejected）。
  // prune.ts 自称"幂等，可定期跑"但零调用方；接在 skill-consolidate（写提案的地方）。
  SKILL_PRUNE_ENABLED: booleanFromEnv.default(false),
  // 信念验证：消费 stale_belief 债务（world_change 产生），把被世界变化证伪的
  // 信念标为 contradicted（getActiveBeliefs 已排除，不再进 prompt）。
  // 此前三件套都在、互不相识：world-facts 产生事件 → projector 建债务 →
  // contradict 能标记，但债务无人读（实测 20 条全 open、207 条 belief 全 active）。
  BELIEF_VERIFY_ENABLED: booleanFromEnv.default(false),
  // Agency 控制动作的宿主实现（observe/remember/correct/stop）。
  // agency-control-adapters 只提供"外壳"（scope/预算/回执契约），宿主实现从未提供，
  // 所以 runtime 派发这些动作时没有可执行体。实现见 agency-host-adapters.ts。
  AGENCY_CONTROL_ADAPTERS_ENABLED: booleanFromEnv.default(false),
  // 跨天的未了事：bot 答应过/在等的（"明天告诉你"），能像真人那样"对了，昨天你说那个…"。
  // 与 scratchpad 的区别：那是 30 分钟工作记忆，这是跨天。只记**明确承诺**，
  // 不做"记住所有对话"——那会变成让人出戏的机械回忆。
  OPEN_THREADS_ENABLED: booleanFromEnv.default(false),
  // sendText 回执带上"距上一条仅 N 秒"的事实注记，让模型自己意识到在连发/同义改写。
  // 不拦截、不扣分——只给事实，改不改由 persona 决定（2026-09-19 困困问候连刷 6 条事件）。
  SEND_PACING_FACT_ENABLED: booleanFromEnv.default(false),
  // 语义重复守卫：bot 在同一任务里把同一个意思换个说法再发一遍（同义改写刷屏）。
  // 字面 bigram Jaccard ≥0.85 的 anti-repeat 抓不到这种（实测相似度仅 0.13~0.27），
  // 所以这里用 TypeSafe System One (Jev) 问一个 Noul。仅在第 2+ 次任务内发送时调用；
  // Je 不可达一律 fail-open 放行（不可因基础设施故障吞掉一句话）。
  SEMANTIC_DUP_ENABLED: booleanFromEnv.default(false),
  // （SEMANTIC_DUP_THRESHOLD 2026-09-21 删除：全仓库（src/scripts/packages/tests，含 .sh）无一处读取。semantic-dup.ts 的判定阈值是写死的 0.7，没读这个键）
  // 接地性守卫：bot 断言一个聊天里没人提过、用户也没问的具体数字/事实（模型幻觉）。
  // 2026-09-19 事故：无锚点消息「（想到瞭不好的東西）」→「2698 换块屏，苹果这刀法确实狠喵」。
  // 先用确定性闸门（含具体数字才问）压调用量；JeV 不可达一律 fail-open。
  GROUNDING_CHECK_ENABLED: booleanFromEnv.default(false),
  // topic_present 低于此值算"聊天里没提过"，user_asked 低于此值算"用户没在问"；两者都低才拦。
  GROUNDING_PRESENT_MAX: z.coerce.number().min(0).max(1).default(0.35),
  GROUNDING_ASKED_MAX: z.coerce.number().min(0).max(1).default(0.35),
  // TypeSafe System One 接入。/v1/systemone；key 是 secret（.env，勿提交）。
  TYPESAFE_ENDPOINT: z.string().default('https://api.typesafe.ai/v1/systemone'),
  TYPESAFE_MODEL: z.string().default('jev-latest'),
  TYPESAFE_API_KEY: z.string().default(''),
  // 房间感知注入：把 frame 已算好的"圈子里谁在跟谁说话/我多久没说话/未了话题"渲染进
  // CodeAct 任务 prompt。真人不是只回上一条的，bot 却永远在回应、从不在参与——
  // 2026-09-19 真人对比分析定为此为"差一口气"的最大来源。fail-soft，默认关。
  // Nyat Trench L0 海床：有界积分器（气压 P / 岸线 θ）+ 时间泵 cron。
  // 论文 docs/plans/2026-09-19-nyat-trench.md。v1 只做"身体先行"：
  // 纯增量，不动任何现有决策路径——heart/judge/gate 照旧跑，
  // 只是 Frame 里多一行身体感受，且 P 有了唯一衰减方。
  // Nyat Trench L2 反射：Echo 学习闭环（确定性回填 + 标量 E ∈ [0.05,0.90] + P 脉冲）。
  // 论文 §3.2 机制三。零 LLM：判据全部来自 bot_interactions / self_replies 的宿主事实。
  // Nyat Trench L1 沟壁：发送前硬闸。把 canSpeakActively()（此前零调用方的死代码）
  // 变成唯一发送出口的前置条件——论文 §1.2 实测确认此前 6条/h+90s 只是事后记账+劝告。
  // 只拦主动发言；被 @/被回复/DM 豁免。
  // Nyat Trench L1 包络：对所有发言生效的物理边界（含被叫到的）。
  // 原 budget 只拦主动发言，而生产 1572 次群发送全带引用锚点=全豁免，
  // 最忙群 266 条/天(11/h) 已超 6/h 上限而无人管——物理边界在流量的那条路上是洞。
  // 默认 shadow：只记录"本来会被拦"，先看数再 enforce。
  TRENCH_ENVELOPE_MODE: z.string().default('off'),        // off | shadow | enforce
  // 默认值不是拍的，是回测出来的（scripts/envelope-backtest.mts，近 3 天 1841 条）：
  //   实测小时窗峰值 107 / p99 64 / p95 37；5 分钟窗峰值 19 / p99 16。
  //   设 150/100 的代价是**拦掉 1 条（0.1%）**——对现有行为不可见；
  //   而判定点投影要把最忙群从 266 条/天推到 ~1048 条/天（峰值小时 107 → ~172），
  //   这个上界正好落在那段空白里：现在看不见，放大后接得住。
  // 第一版用 5 分钟窗 + 8/3，回测会拦 23%——因为 bot 本来就突到 19 条/5 分钟。
  TRENCH_BURST_MAX: z.coerce.number().int().positive().default(150),
  TRENCH_BURST_MAX_ACTIVE: z.coerce.number().int().positive().default(100),
  TRENCH_BURST_WINDOW_SEC: z.coerce.number().int().positive().default(3600),
  // Nyat Trench L0 × 睡眠：读到的但没法回的消息记成气压（0.5/条）。
  // 此前这段积累完全不存在——睡眠时段消息进 pending 队列，醒来时 P=0，
  // bot 像什么都没发生过。加上之后醒来后气压偏高 → 速率上限被 g(P) 抬高，
  // 即"睡一觉错过一场对话，醒来头几句是密的"，之后被释放与泵浦压平。
  // 多不多说仍由模型在 Frame 里判断，宿主只提供事实。
  TRENCH_SLEEP_PULSE_ENABLED: booleanFromEnv.default(false),
  // 定向债 → 注意力权重（论文 §九·补六 实验 B）。默认关。
  // 实测：债被 Frame 呈现但 0/28 进入选择。这一条把债接到**选择侧**：来自债主的消息
  // 在注意力累加时获得 +DEBT_ATTENTION_BOOST 压力。宿主侧确定性加权，不改模型。
  TRENCH_DEBT_ATTENTION_ENABLED: booleanFromEnv.default(false),
  TRENCH_DEBT_ATTENTION_BOOST: z.coerce.number().min(0).max(5).default(0.5),
  TRENCH_GATE_ENABLED: booleanFromEnv.default(false),
  // Nyat Trench 定向债：睡眠期按**发送者**记"欠谁一句"，醒来只准对那个人兑现。
  // 评审 3 的反对意见：无方向的睡眠积压醒来后只被半衰期压平（时钟驱动=痉挛签名），
  // 有方向则被"还债"驱动（闭环驱动=活人）。速率上界仍由标量 P 决定，不改积分器。
  TRENCH_DEBT_ENABLED: booleanFromEnv.default(false),
  ECHO_ENABLED: booleanFromEnv.default(false),
  TRENCH_PUMP_ENABLED: booleanFromEnv.default(false),
  ROOM_AWARENESS_ENABLED: booleanFromEnv.default(false),
};
