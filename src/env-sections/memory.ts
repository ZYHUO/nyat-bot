// ────────────────────────────────────────
// env schema · memory 段
// ────────────────────────────────────────
// 记忆：主动参与、DM↔群记忆连结、长期记忆嵌入与相关性、CodeAct 长期记忆注入
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

export const memorySection = {
  // ── Proactive Engagement (Stage B) ──
  JUDGE_PROACTIVE_ENABLED: booleanFromEnv.default(false),
  // H1.1 floor/addressee 三档（默认 OFF，OFF = 老路零变化）。
  // 开后：ambient/not_me 先记 floor_decisions 再按规则短路，to_me 才进 judge。
  FLOOR_ENABLED: booleanFromEnv.default(false),
  JUDGE_PROACTIVE_RATE: z.coerce.number().min(0).max(1).default(0.25),
  JUDGE_PROACTIVE_MIN_INTERVAL_SEC: z.coerce.number().int().positive().default(120),
  JUDGE_PROACTIVE_MIN_RECENT_MSGS: z.coerce.number().int().positive().default(3),

  // （原 PROACTIVE_SCAN_* / PROACTIVE_PRESSURE_* / SCHEDULE_LLM_WAKE 三个旗标
  //   2026-09-21 删除：全仓库无一处读取，.env 里却开着。前者对应的独立 scan cron
  //   已被 unified-tick 取代，后两者描述的机制从未落地。留着只会让人以为能调。）
  // Prometheus /metrics(借鉴 CGM:LLM 事件总线 → token/缓存/延迟按用途可见)。默认关。
  METRICS_ENABLED: booleanFromEnv.default(false),
  // 跨群人物身份(借鉴 CGM 两层人物模型):在别的群也认得的人,带上跨群整体印象。默认关。
  PERSON_IDENTITY_ENABLED: booleanFromEnv.default(false),
  // ── DM↔群记忆连结(借鉴 CyberGroupmate 以人为中心统一记忆;docs/dm-group-memory-*.md)──
  // 机制1 隐私 visibility 兜底:记忆/画像跨上下文返回前按 private/contextual/public
  // 逐条 scrub(DM 默认 private,群默认 contextual)。是机制3/4 跨上下文共享的前置门,
  // 关闭时跨上下文入口一律 fail-closed 拒绝返回。默认关。
  MEMORY_VISIBILITY_ENABLED: booleanFromEnv.default(false),
  // 始终视作私密的会话(逗号分隔 chatId;群为负数)。DM 由 DM_AUTO_PRIVATE 自动判定。
  MEMORY_SENSITIVE_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n !== 0);
    }),
  // DM 是否自动判为私密会话(CGM dmAutoPrivate)。默认 true。
  DM_AUTO_PRIVATE: booleanFromEnv.default(true),
  // 机制5 LLM 全局画像合并 cron:低频把某人各上下文(群+DM)画像喂便宜模型提炼成
  // 全局 traits/interests/relation,写回 person_identity 全局列。默认关。
  PROFILE_MERGE_ENABLED: booleanFromEnv.default(false),
  // 合并灰度群列表(逗号分隔 chatId,群为负数),空 = 对所有上下文生效。
  PROFILE_MERGE_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n !== 0);
    }),
  // 全局画像合并走哪个便宜模型 usage 路由。
  PROFILE_MERGE_USAGE: z.string().default('summarize'),
  // 机制4 跨上下文记忆召回:per-uid 旁路检索(不锁 chatId),返回强制过 visibility
  // scrub(默认带 public + 非私密来源 contextual,private 一律剔除)。
  // **必须** MEMORY_VISIBILITY_ENABLED 也开才生效(fail-closed)。默认关。
  MEMORY_CROSS_CONTEXT_ENABLED: booleanFromEnv.default(false),
  // ── 长期记忆嵌入模型 / collection / 相关性下限 ──────────────
  // 默认的 all-MiniLM-L6-v2 是**英文单语**模型,而本 bot 是中文群聊。生产机实测中文
  // 同义 0.7543 / 无关 0.6097 → 区分度仅 0.1446(「打篮球」vs「查比特币价格」相似度
  // 0.7210,比英文同义句对的 0.7025 还高),即语义检索接近随机。
  // paraphrase-multilingual-MiniLM-L12-v2 同为 384 维、区分度 0.5592(3.9x)。
  // 换模型后新旧向量空间不兼容,**必须整库重嵌入**:scripts/reembed-memory.ts 灌进
  // 新 collection → 改 MEMORY_COLLECTION 切换 → 旧库保留一周作回滚。
  MEMORY_EMBED_MODEL: z.string().default('Xenova/all-MiniLM-L6-v2'),
  MEMORY_COLLECTION: z.string().default('xxb_group_history'),
  // 检索相关性下限(0..1)。0 = 不过滤,保持历史行为(纯 topK)。
  // 换模型与调阈值刻意分成两次改动;标定必须用真实语料,别沿用旧模型下的经验值。
  MEMORY_MIN_SCORE: z.coerce.number().min(0).max(1).default(0),
  // 混合检索:向量召回 + FTS5 BM25 词法召回,按 RRF(名次融合)合并。
  // 384 维小模型对专有名词/群内黑话/型号天然弱(jargon-miner 挖的正是这类词),
  // BM25 补的就是这一块。关闭时完全走旧的纯向量路径。默认关。
  MEMORY_HYBRID_ENABLED: booleanFromEnv.default(false),
  // 写入侧近重复合并:命中已有近邻时不新增点,改为顶高它的 ref_count
  // (「这件事又被说了一次」语义上是强化,不是复制)。压制「哈哈哈」「+1」这类刷屏。
  // **阈值必须在换完嵌入模型之后标定** —— 旧的英文单语模型下中文相似度普遍虚高
  // (无关句对都有 0.72),0.93 在旧向量空间里会命中几乎一切,等于把记忆写没了。默认关。
  MEMORY_DEDUP_ENABLED: booleanFromEnv.default(false),
  MEMORY_DEDUP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.93),
  // ── CodeAct 自动注入长期记忆 ──────────────────────────────
  // 接在 subagent/executor.ts(真正生成话语的那层),**不是** Meta 编排器 ——
  // Meta 的引擎跨所有会话,其输出经 digest/梦境日记扩散到每个群的 prompt,
  // 私聊记忆进 Meta 就有一条通往别的群的洗白路径(与那次"私聊原文被念到群里"同源)。
  SUBAGENT_MEMORY_ENABLED: booleanFromEnv.default(false),
  // 灰度名单。**空 = 关闭**,与本仓其他 flag 的「空 = 全量」刻意相反:
  // 这是隐私相关特性,配错的代价不对称 —— 漏开只是没效果,误开是内容外泄。
  SUBAGENT_MEMORY_CHAT_IDS: z
    .string()
    .default('')
    .transform((s) => {
      const t = s.trim();
      if (!t) return [] as number[];
      return t.split(',').map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n) && n !== 0);
    }),
  SUBAGENT_MEMORY_TOPK: z.coerce.number().int().min(1).max(10).default(3),
  // 上下界都要:下界防 `TIMEOUT-50` 变成 0 导致「记忆永远为空且与无命中不可区分」,
  // 上界防有人调大后阻塞 CodeAct(那是生产热路径)。
  SUBAGENT_MEMORY_TIMEOUT_MS: z.coerce.number().int().min(100).max(1000).default(400),
  SUBAGENT_MEMORY_MAX_CHARS: z.coerce.number().int().min(100).max(2000).default(600),
  // 话题生命周期注册表(借鉴 CGM Topic Registry):cron 抽取各群当前话题 + 注入「当前话题」。默认关。
  TOPIC_REGISTRY_ENABLED: booleanFromEnv.default(false),
  TOPIC_SCAN_INTERVAL_MIN: z.coerce.number().int().positive().default(8),
  // 优化:direct 模式只取最近 N 条(原 50)——砍掉不可缓存的上下文体积,降 token/延迟。
  REPLY_DIRECT_RECENT_WINDOW: z.coerce.number().int().positive().default(30),
  // 优化:缓存预热——定时拿静态 system 前缀 ping 回复模型,保持 DeepSeek 前缀缓存热(默认关)。
  CACHE_WARMUP_ENABLED: booleanFromEnv.default(false),
  CACHE_WARMUP_INTERVAL_MIN: z.coerce.number().int().positive().default(4),
  // DM↔群联动:睡着时收到私聊 → 全局临时唤醒(群里也醒、正常处理消息),窗口内每条 DM 续期,
  // 静默后到点自动继续睡。默认关。
  SLEEP_WAKE_ON_DM_ENABLED: booleanFromEnv.default(false),
  SLEEP_WAKE_WINDOW_MIN: z.coerce.number().int().positive().default(20),
  // 回复写手强制合法 JSON(DeepSeek/OpenAI json_object)——根治单引号/Python-dict 脏输出。默认关。
  REPLY_JSON_MODE: booleanFromEnv.default(false),
  // P2 多模态直读:回复写手调用直接带原图(默认关 = 只用文本描述)。
  // 开前确保回复链主 label 声明 AI_PROVIDER_<NAME>_VISION=true,
  // 纯文本 label 声明 VISION=false 让 fallback 跳过(不白烧 400)。
  REPLY_VISION_ENABLED: booleanFromEnv.default(false),
};
