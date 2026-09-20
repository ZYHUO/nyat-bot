// ────────────────────────────────────────
// env schema · life 段
// ────────────────────────────────────────
// 生活与身体：硬作息门、DM 好感私聊、上学日程、心情漂移、自我叙事、NyatOS 影子、发言额度、关系叙事、TTS
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

export const lifeSection = {
  // ── Sleep schedule(硬作息门):到点真睡觉,睡觉不闲聊,指令照常 ──
  // 直接交互(@/回 bot/私聊)走升级式吵醒,主人必醒;作息表沿用
  // life-state 的 date-seeded daySchedule(起床 07:00-08:30 / 入睡 23:30-01:00)
  SLEEP_SCHEDULE_ENABLED: booleanFromEnv.default(false),
  // 到点睡觉/起床时向最近活跃的群发晚安/早安(固定短句池,无 LLM)
  SLEEP_ANNOUNCE_ENABLED: booleanFromEnv.default(false),
  // 晚安时机守卫:就寝边沿若 bot 5 分钟内在活跃群说过话(对话中),推迟
  // 入睡相位 10 分钟,每晚最多 3 次 —— 治"自己刚回完话 50 秒就道晚安蒸发"。
  SLEEP_BEDTIME_GUARD_ENABLED: booleanFromEnv.default(false),

  // ── DM 好感主动私聊 (功能 B) ──
  // B1:睡前/起床给「已私聊过 bot 的高好感用户」发悄悄话(带跨群外号)。默认关。
  SLEEP_DM_ENABLED: booleanFromEnv.default(false),
  DM_GREET_AFFINITY_MIN: z.coerce.number().default(40),
  DM_GREET_MAX_USERS: z.coerce.number().int().default(2),       // 每个边沿最多几人
  DM_PROACTIVE_COOLDOWN_HOURS: z.coerce.number().default(20),    // 同人两次主动 DM 最小间隔
  // B3:群里@催pm(高好感但从没 DM)。最危险,默认关灰度。


  // 常驻贴纸包(逗号分隔的贴纸包 set_name):作为 bot 主力贴纸,选择时占多数候选槽。
  RESIDENT_STICKER_PACKS: z.string().optional(),

  // 控制指令(别理我/别理某人/可以说话了/记住X/忘掉X):typing 前用 LLM 听懂 →
  // 静默执行 + emoji ack,取代旧的 L0 关键词 regex。默认关。
  CONTROL_DIRECTIVE_ENABLED: booleanFromEnv.default(false),

  // ── Daily life / school schedule ──
  // 16 岁人设的「每日安排」：school=周课表，summer=暑假日计划，auto=7–8 月暑假否则上学。
  // SCHOOL_SCHEDULE_ENABLED 关 → 不注入。睡眠硬门仍优先于本模块。
  SCHOOL_SCHEDULE_ENABLED: booleanFromEnv.default(false),
  DAILY_LIFE_PROFILE: z.enum(['auto', 'school', 'summer']).default('auto'),

  // ── Mood drift (Stage E) ──
  // Bot 每个群独立 valence ∈ [-100, 100]，随事件起伏，按时间向 0 衰减。
  MOOD_ENABLED: booleanFromEnv.default(false),
  // 每小时衰减比例 (0..1)。0.3 = 1 小时后保留 70% 强度
  MOOD_DECAY_RATE_PER_HOUR: z.coerce.number().min(0).max(1).default(0.3),
  // 是否把 mood hint 注入 reply prompt
  MOOD_INJECT_ENABLED: booleanFromEnv.default(false),
  // |valence| < 该阈值时不注入 prompt（默认 calm 不打扰）
  MOOD_INJECT_THRESHOLD: z.coerce.number().int().nonnegative().default(20),

  // ── Self-narrative (Stage F): bot 记得自己对每个用户说过什么 ──
  // 同一开关也驱动"我最近在这个群的整体表现"（含每条消息的真实结果），
  // 心流决策会看到这个事实块 —— 模型据此自己判断要不要收着点。
  SELF_HISTORY_ENABLED: booleanFromEnv.default(false),
  SELF_HISTORY_INJECT_LIMIT: z.coerce.number().int().positive().default(5),
  SELF_HISTORY_WINDOW_DAYS: z.coerce.number().int().positive().default(30),
  // 心流看到的"近况"窗口（分钟）。只影响行为史事实块，不影响对某人的一致性注入。
  SELF_HISTORY_WINDOW_MIN: z.coerce.number().int().min(5).max(720).default(45),
  // 认知时钟：把模型自己的行动结果写进事件账本（own_action_result），
  // 并允许它记录"下次什么时候再想"（self_scheduled_wake）。
  // 没有前者，模型看不见自己刚做过什么（自激事故的根因）；没有后者，
  // 注意力主权在宿主手里，系统永远是被动应答器。
  COGNITIVE_CLOCK_ENABLED: booleanFromEnv.default(false),

  // ── NyatOS Phase 2: 单决策点并联影子 ──
  // 用同一个 Frame 跑一次「说话/等待/不说」的判断，**只记录不发送**，
  // 与现有 pipeline 的实际选择对比。目的是在信任新架构之前先量化它，
  // 而不是直接上线然后观察。绝不产生任何外部副作用。
  NYATOS_SHADOW_ENABLED: booleanFromEnv.default(false),
  // 影子判断的灰度群（空 = 开启后全量）。影子每次会多一次 LLM 调用，
  // 先限定内部群可以把成本与干扰都控制住。
  NYATOS_SHADOW_CHAT_IDS: z
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
  NYATOS_SHADOW_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),

  // ── NyatOS 发言额度：宿主提供的物理节流，但模型可见 ──
  // 2026-09-18 的 54 样本实测：单决策点在 28 分钟内想说 48 次（中位间隔 7 秒），
  // 即使明确告知"你刚发了 4 条没人回"仍然继续想说。所以旧 cooldown 的第二份
  // 工作——防止自我重复失控——不能交给模型。但它不该是一个隐形计时器，
  // 而应该是模型能看见、能花、能推理的额度（像消息长度上限一样属于现实约束）。
  NYATOS_BUDGET_ENABLED: booleanFromEnv.default(false),
  NYATOS_BUDGET_WINDOW_SEC: z.coerce.number().int().min(60).max(86_400).default(3600),
  NYATOS_BUDGET_MAX_ACTS: z.coerce.number().int().min(1).max(200).default(6),
  // 两次主动发言之间的最小间隔（秒）。计数额度挡不住"1 分钟连发 6 条"——
  // Phase 2.3 实测的 48 次/28 分钟、中位间隔 7 秒正是这个形状。
  // 这是"我刚说过，让别人说"的那一半，与计数额度互补。0 = 关闭。
  NYATOS_BUDGET_MIN_GAP_SEC: z.coerce.number().int().min(0).max(3600).default(90),
  // 两次**被叫到**的回复之间的最小间隔（秒）。
  //
  // 2026-09-21 补上这条的原因：原来最小间隔只拦主动发言，而被叫到的那条路
  // （生产流量几乎全带引用锚点）**一点间隔都没有**。实测近 3 天 3008 次群发送：
  //   小时窗 p50=6 / p90=26 / p99=63 / max=107
  //   5 分钟窗 p50=2 / p90=8 / p99=15 / max=20
  // 最忙群平均 19.4 条/小时。用户原话："日常都有点过高频率"。
  //
  // 比主动发言的 90s 松得多（默认 30s）：无视直接提问是另一种失败，这里只要
  // 削掉"5 秒内连回三个人"那种机器形状，不是要 bot 装死。0 = 关闭。
  NYATOS_BUDGET_MIN_GAP_ADDRESSED_SEC: z.coerce.number().int().min(0).max(3600).default(30),

  // ── Relationship narrative (Stage F): 每对 (chat,user) 累计 affinity ──
  RELATIONSHIP_ENABLED: booleanFromEnv.default(false),
  // |affinity| < 该值时不注入 prompt（默认 一般 关系不打扰）
  RELATIONSHIP_INJECT_THRESHOLD: z.coerce.number().int().nonnegative().default(20),

  // Monitor
  MONITOR_TOKEN: z.string().default(''),

  // Admin
  ADMIN_CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) => (s ? s.split(',') : [])),

  // Cutover (optional — only used by scripts/cutover.sh)
  TS_WEBHOOK_URL: z.string().url().optional(),
  PHP_WEBHOOK_URL: z.string().url().optional(),

  // ── TTS voice messages (edge-tts, free local Python) ──
  // 把短回复概率性转成语音发送(适合短促亲昵/深夜私聊/情绪强烈的回复)。
  // edge-tts 生成 MP3 → ffmpeg 转 OGG/Opus(Telegram 语音消息要求 OggS+Opus)。
  // 全部默认关;开启需系统装好 `python3 -m edge_tts` 与 `ffmpeg`。
  TTS_ENABLED: booleanFromEnv.default(false),
  // edge-tts 语音名(中文默认晓晓;也可换 zh-CN-XiaoyiNeural 等)。
  TTS_VOICE: z.string().default('zh-CN-XiaoxiaoNeural'),
  // 每条满足条件的短回复转语音的概率(0..1)。
  TTS_VOICE_PROBABILITY: z.coerce.number().min(0).max(1).default(0.15),
  // 仅对不超过此字符数的回复转语音(长消息发语音很烦)。
  TTS_MAX_CHARS: z.coerce.number().int().positive().default(100),
};
