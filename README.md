<div align="center">

# 🐱 NyatBot

**Telegram AI 群聊喵娘机器人 — 拟人回复引擎**

一只会思考、会回嘴、还会跟群友互动的 AI 群聊机器人。

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![grammy](https://img.shields.io/badge/grammy-Bot_Framework-009DC4)](https://grammy.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](#english) · [中文](#中文)

</div>

---

## 中文

### ✨ 特性

**核心 AI**
- 🧭 **Meta + Subagent + CodeAct**（可选，默认关）— CyberGroupmate 同构编排：Attention 收消息 → Meta 写 JS 派活 → Subagent CodeAct 调 host API（发消息/记忆/贴纸）→ callback；灰度 `META_SUBAGENT_CHAT_IDS`，详见 [`docs/meta-subagent/`](docs/meta-subagent/)
- 🧱 **Context Engine** — `static|delta|ephemeral|volatile` 分段组装 + Manifest（前缀稳定利于 prompt cache）；Meta/Subagent 共用
- 📔 **梦境日记（Dream Journal）** — 夜间 cron 写 `data/dream-journal/`，可发频道；与记忆遗忘的 `memory-dream` 无关（`DREAM_JOURNAL_*`）
- ❤️ **心流层（Heart）** — 一颗带人格与"此刻自我状态"的心代替三个过滤器：L0 规则未命中的群消息走**一次**心流判断，自己决定 reply / wait / pass —— 决定"接不接"的我和决定"怎么说"的我是同一个我（更便宜：1 次调用 ≤ 旧的 1-3 次）；可选「念头」反思（`HEART_REFLECT_ENABLED`）
- 🔄 **回合制 Turn Actor** — MaiBot 式 per-chat 认知回合：连发合并成一个念头整体评估、生成中被新消息打断→重规划、"等TA说完"真的会回来接话（wait-resume）、有界自我接话（"对了…"/补贴纸）
- 🧠 **三级判断管线** — L0 本地规则 → L1 微型 AI → L2 完整 AI，智能决定是否回复（心流关闭时的回退链路；**Meta 灰度群不走此路径**，防双回复）
- 💬 **自然接话** — bot 说完话后保持"在场"：最近几条内你或它任一方是问句即接，陈述句也按概率接（MaiBot 式 talk-frequency），不需 @ 或引用；群太热/@别人时自动克制
- 🗣️ **自然语言调用指令** — "帮我签到"→签到、"看看我的图鉴"→卡册、"追踪比特币"→关注话题，私聊宽松、群里需点名
- 💬 **多条回复 / 多目标** — AI 可一次性回复多个人（JSON 数组），每条精准引用各自目标
- 🔄 **流式回复** — 打字中效果，逐段更新消息，用户体验流畅
- 🛠️ **工具调用** — 联网搜索（**Gemini Google-Search grounding** 主路由 → xAI / SearxNG / DDG 回退）、网页抓取、IP 查询、定时器
- 🎒 **真实身份 · 上学日程** — 16 岁高中生人设:确定性周课表 + 节假日/补课 override，上课偷瞄手机回得短、课间/放学话变多、每天一句「今日感想」,作息与睡眠层联动（migration 0040）
- 🎯 **多模型路由** — Judge / Reply / Reply Pro / Vision / Summarize 分配不同模型；Redis 运行时可覆盖
- 🏎️ **Hedged Request + 熔断器** — 主模型 2s 未回自动并发备用请求谁快用谁；连续失败指数退避熔断（`xxb:circuit:*`，成功自动恢复）；hedge 输家的 abort 不污染熔断计数
- 👁️ **视觉理解** — 图片/表情描述，结果缓存复用（migration 0028）；主 stepfun，备份 Kimi / grok-4.3

**拟人回复（Humanizer V2）**
- ✍️ **错别字 + 编辑纠正** — 30% 概率注入错别字，1.5s 后 editMessage 静默修正
- ⏱️ **阅读延迟** — 根据用户输入长度计算 0.8-5s 延迟，模拟真人"阅读中"
- 👋 **确认前缀** — 25% 概率先发"嗯"/"…"，1.5s 后再发主回复
- 🔄 **撤回重发** — 3% 概率删掉中间/末尾段，微调用词后重发
- 🎭 **贴纸短回复** — ≤15 字回复 15% 概率替换为纯贴纸（按意图匹配表情贴纸池）
- 💭 **思考插入** — 长回复 10% 概率在第 1-2 段间插入"我想想"/"等下"
- 📝 **回看修改** — 5% 概率发完 2-5s 后 edit 微调（加 emoji/语气词/删标点）
- ⌨️ **打字指示对齐** — 所有延迟前触发 typing，>5s 延迟在 4.5s 重触发
- 🎲 **随机抖动** — 所有时间延迟 ±20% 随机偏移，避免机械感
- 🔀 **分段回复** — 代码驱动的智能断句（标点保护、颜文字保护、概率合并），替代 LLM 分段节省一次调用

**群组功能**
- 👥 **群成员花名册** — 自动追踪所有群成员的 username ↔ 显示名，注入 AI 上下文
- 🤖 **Bot 交互知识库** — 记录群里其他 bot 的行为，AI 自动生成摘要，回复时注入知识
- 🚫 **智能 Bot-to-Bot 屏蔽** — 有人类在场时不和其他 bot 聊天，无人时限制回合
- ✅ **每日签到** — `/checkin` 连续签到、排名、里程碑（7/30/100 天）、AI 自由发挥奖励
- 🏅 **声望系统** — 群友互动累积声望（migration 0014），行为角色自动标签（migration 0029）
- 😺 **情绪 + 关系** — 每群情绪 valence（migration 0017）、对每位群友的好感度随时间衰减（migration 0018）
- 🕸️ **群友社交图** — 追踪群友之间（非 bot↔人）的互动关系，注入回复 prompt「A 和 B 常互动」让猫娘读懂群气氛（migration 0034）
- 😻 **emoji 反应** — `setMessageReaction` 轻量"已读卖萌"，对好笑/可爱/秀的消息偶尔反应，每群每天硬上限 2 次、不调 LLM
- 🔭 **关注目标** — DM 里 `/watch 事项` 或自然语言「回头提醒我」，立成关注目标，到点主动跟进
- 🛡️ **入群验证 + 白名单** — 申请入口即 bot 对话：私聊报群 ID/@username，AI 自动审核（申请人经核验为群管理才自动启用，其余转 Master DM 评判）；bot 被拉进群也会自动先审一遍；验证问答兜底

**私聊功能（DM 助手）**
- 📨 **传话/带话** — 私聊让本喵把话带到群里，可指定对象
- 📜 **匿名小纸条** — 匿名给群里某人留言 + 手动"猜作者"小游戏（migration 0020）
- 🌳 **树洞倾诉** — 匿名把心事分享到群，AI 温暖回应
- 🔮 **缘分签** — 抽签/运势（migration 0022）
- ⏰ **定时提醒** — 自然语言设提醒，到点喊你（"明天早上 6 点叫我"）
- 🗂️ **群友档案/备注** — 记录与查看群成员资料（migration 0021）
- 🎛️ **功能开关** — `/feature` 群管按需开关各 DM 功能；`/setdefault` 设默认群
- 💗 **好感度驱动主动私聊** — 跨群累积好感（非简单累加,√加权压缩）；对已私聊过的高好感群友睡前/起床发悄悄话（带跨群外号画像）；达高好感但从没私聊→群里 @ 喊"来 pm"（≤3 次递增间隔 + 全局每日上限 + allowlist/mute/成员/作息安全门,默认灰度）；攒着想说的话等对方私聊时自然说出（migrations 0040-0041）

**收集 · 游戏 · 互动**
- 🐾 **猫娘卡牌收集** — 26 张 N/R/SR/SSR/UR 猫娘卡，**签到免费解锁**（保底机制，无氪金），`/cards` 看图鉴（migration 0032）
- 💞 **心愿单换卡** — `/wish add 卡名` → `/wish holders/wanted` 自动撮合群友间换卡
- 🎲 **派对小游戏** — `/game tod`（真心话）`dare`（大冒险）`wyr`（二选一）`nhie`（我从未）`guess`（猜数字）
- 🧠 **偏好记忆** — `/remember` 记住你的偏好，回复时自动注入

**记忆 · 学习 · 自我进化**
- 🏷️ **人物外号持久记忆** — 自动捕获"X 的外号是 Y"，跨会话不忘（migration 0027）
- 📖 **群共同经历记忆** — cron 把群里发生的事摘要成"往事"，聊天命中时注入「群里的往事」让本喵像老群友一样 callback；相关性评分召回（distinct 关键词 × salience 门槛），杜绝"今天/这个"式偶然重叠的误召回（migration 0035）
- 🧵 **持续内心（Mind）** — 上一个念头/立场跨消息延续，判断与写作共用同一段第一人称自我叙述，不再每条消息失忆重启
- 🧲 **长期语义记忆（多语言 + 混合检索）** — 本地嵌入 `paraphrase-multilingual-MiniLM-L12-v2`（中文群聊；旧英文 MiniLM 中文区分度接近随机）+ Qdrant 向量召回；可选 FTS5 BM25 词法旁路经 RRF 融合（专名/黑话/型号）；`MEMORY_MIN_SCORE` 相关性下限滤噪声；写入侧近重复合并与保护/永久档（migrations 0051–0052，flag 门控）。整库重嵌入用 `scripts/reembed-memory.mts`（`--delta` / `--fts-only`）
- 🧩 **记忆重要度 + 遗忘** — 记忆按重要度评分，低价值记忆随时间淡忘（migration 0030），梦境式整理 cron
- 📚 **黑话学习** — 自动挖掘群内黑话/梗，多阶段精炼释义（migration 0016/0026）
- 📇 **结构化用户画像** — 7 分节画像（身份/关系/稳定事实/偏好/近况…，migration 0025）
- 🎚️ **表达学习门控** — 学习群体语言风格，带质量门控（migration 0031）
- 📈 **回复质量自评（ASI）** — 多维评分自家回复，rolling EMA 反哺 humanizer 自调（migration 0024）
- 🎯 **结果追踪 + 奖励门控** — 追踪每条回复后续反应（被夸/被怼/被无视），调整情绪与策略

**基础设施**
- 📦 **BullMQ 消息队列** — Redis 支撑的高并发处理（可配置并发数）
- 🗃️ **双存储 + 向量库 + NyatDB** — Redis（上下文、缓存、速率限制）+ SQLite（持久化、知识库、追踪、FTS5 词法索引）+ **Qdrant**（语义记忆，int8 量化，进程内多语言本地嵌入）+ 可选 [**NyatDB**](https://github.com/ZYHUO/nyatdb)（页式嵌入 ChatLog，双写/可读，默认关）
- 🔁 **Ingress 自动故障转移** — 默认长轮询（不对外开放端口）；轮询挂掉自动切 webhook 备用，由 Redis 标志 + 看门狗控制
- 📊 **Admin Mini App** — Telegram WebApp HMAC 认证，macOS 窗口风格 UI，运行时配置管理
- ⏰ **Cron 定时任务** — 模型健康检查、用户画像同步、空闲主动消息、频道抓取、记忆整理、学习扫描、数据清理（并发门控；日志表 90/180 天滚动 retention）
- 🔐 **安全防护** — SSRF 防护、webhook constant-time 验证、速率限制、Redis Lua 原子操作、去重锁
- 📡 **频道消息源** — 自动抓取公开 Telegram 频道内容存入 Qdrant 向量库，无需管理员权限
- 🔥 **Firecrawl 抓取兜底** — JS 重页面 / Cloudflare 验证页:免费路由（直连 → 本地浏览器绕过 → Jina Reader）全失败后落到自托管 Firecrawl（无头浏览器过 CF JS Challenge）。NodeSeek 等强 CF 站点直接走 Firecrawl,默认关、配 key 才启用
- 🔌 **Skill 插件系统** — data/skills/*.json 添加自定义工具，支持 HTTP 调用，内置 SSRF 防护
- 🎨 **359 个贴纸意图 + 常驻贴纸包** — AI 按意图自主选贴纸（top-N 截断 + Levenshtein 模糊 + 反感反馈）;指定贴纸包作「常驻主力」（走视觉识图生成情绪标签、忽略 emoji,选择时预留多数候选槽,其余学习来的贴纸仍可用）（migrations 0042-0043）
- 🚀 **一键部署** — `scripts/deploy.sh` / `scripts/install.sh` 端到端：依赖 → Qdrant →（可选）NyatDB native → 构建 → systemd → 自检
- 🧪 **单元测试** — vitest 全绿基线（`npm run test`）；53 个 SQLite 迁移自动按序应用
- 🪦 **优雅关机契约** — worker 排干在飞任务、游离的自我接话统一中止信号排干、写缓冲落盘,SIGTERM 不丢消息不留孤儿锁

### 🏗️ 架构

```
Telegram Update  (长轮询 ⇄ webhook 自动故障转移)
  │
  ▼
grammy Bot
  │
  ├─【可选 META_SUBAGENT】Attention(Redis) ──→ Meta loop(tick)
  │       │                                      │
  │       │                                 Meta CodeAct
  │       │                                      │ dispatch.taskToGroup
  │       │                                      ▼
  │       │                               Subagent CodeAct
  │       │                         (telegram / memory / stickers)
  │       └────────────────────────── callback ──┘
  │         （灰度群：不入 BullMQ / Turn Actor，防双回复）
  │
  └─【默认路径】Turn Buffer (Redis) ──→ chat_turn (BullMQ)
                 │
                 Pipeline Orchestrator (pipeline.ts)
                     │
                 Formatter ──→ Context (Redis ± NyatDB 双写)
                     │
                 L0 rules ──未命中──→ ❤️ Heart (心流: reply/wait/pass)
                     │                    │   (+ 可选念头反思)
                     │                    │   (打断 → 重规划 · wait → 真回访)
                IGNORE / NL-cmd / DM    REPLY
                    intercepts            │
                     │              Reply Pipeline (stages/deliver)
                     │                     ├─ 4-Way Context Retrieval
                     │                     │   ├─ Recent Window
                     │                     │   ├─ Thread Trace (reply chain)
                     │                     │   ├─ Entity Mentions
                     │                     │   └─ Semantic (Qdrant, int8)
                     │                     ├─ 5-Layer Prompt Builder
                     │                     │   (+画像/外号/情绪/关系注入)
                     │                     ├─ Tool Executor (search, fetch...)
                     │                     ├─ Multi-Reply Parser
                     │                     ├─ Humanizer (self-tuning)
                     │                     └─ Streaming Sender
                     ▼
                 DM Assistant (传话/纸条/树洞/缘分签/定时/档案)
                 · Cards & Games (/cards /wish /game) · Checkin

  ├─ Member Registry (Redis Hash)      ├─ Mood / Relationship / Reputation
  ├─ Bot Interaction Tracker (SQLite)  ├─ Outcome + ASI quality tracking
  ├─ Rate Limiter (Redis Lua)          ├─ Learners (jargon / expression)
  ├─ Dedup Lock (Redis NX)             └─ Memory (importance + forgetting)
  └─ Allowlist + Join Verify

Hono HTTP Server
  ├─ /health   ├─ /miniapp_api (Admin)   └─ /webhook (failover)

Cron: model health · profile sync · idle proactive · channel ingest
      · memory dream · dream-journal · learner scan · cleanup
      · relationship summarize · sleep cycle · pm-nudge
      · school day-plan · resident-sticker vision
```

### 📁 项目结构

```
src/
├── index.ts              # 入口 — 启动 bot + API + worker + cron
├── env.ts                # Zod 环境变量校验 (40+ 参数)
├── admin/                # Hono Admin API + HMAC-SHA256 认证
├── ai/                   # AI 调用层
│   ├── provider.ts       #   Vercel AI SDK 统一调用
│   ├── fallback.ts       #   回退链 + hedged request
│   ├── labels.ts         #   模型路由配置
│   └── token-counter.ts  #   tiktoken 计算
├── allowlist/            # 群聊白名单 — bot 对话流申请 + AI 审核 + Master 评判
├── bot/                  # grammy bot
│   ├── handlers/         #   消息处理 + 成员事件
│   ├── middleware/        #   白名单 + 速率限制
│   └── sender/           #   流式发送 + Telegram API
├── cron/                 # 定时任务 (node-cron)
├── db/                   # Redis (ioredis) + SQLite (better-sqlite3)
├── knowledge/            # 知识库 + 贴纸 + 人物外号
├── learners/             # 黑话挖掘/释义 + 表达学习门控 + 学习并发门
├── memory/               # Qdrant 语义记忆 (多语言嵌入/混合检索/保护档) + 重要度/遗忘
├── meta/                 # Meta 编排 (Attention / loop / CodeAct session)
├── subagent/             # Subagent CodeAct + host API (telegram/memory/stickers)
├── context-engine/       # static|delta|ephemeral|volatile 上下文组装
├── nyatdb/               # 宿主适配：NYATDB_* → @nyat/nyatdb（引擎在 packages/nyatdb）
├── ingress/              # 长轮询 ⇄ webhook 故障转移
├── pipeline/             # 核心消息管线（Heart / Turn Actor；非 Meta 灰度路径）
│   ├── pipeline.ts       #   编排器 (orchestrator)
│   ├── stages/           #   管线阶段模块 (media/intercepts/stale-reply/deliver)
│   ├── heart/            #   心流层 (decision + self-state + mind + engagement)
│   ├── turn/             #   回合制 actor (buffer/scheduler/focus/self-continue)
│   ├── context/          #   上下文管理 + 压缩 + 4路检索
│   ├── judge/            #   三级判断 (rules + micro + full AI, 心流回退链路)
│   ├── reply/            #   回复生成 + 解析 + prompt构建
│   │   ├── segmenter.ts  #     代码驱动的智能断句
│   │   └── humanizer.ts  #     拟人化模块 (错别字/延迟/撤回/贴纸/自调...)
│   ├── dm-relay/         #   私聊助手 (传话/纸条/树洞/缘分签/定时/档案)
│   ├── gacha/            #   猫娘卡牌收集 + 心愿单换卡
│   ├── games/            #   派对小游戏
│   ├── nl-commands.ts    #   自然语言 → 指令路由
│   ├── timing/           #   节奏/时序状态 (timing gate + chat runtime)
│   └── tools/            #   工具系统
├── queue/                # BullMQ 队列
├── shared/               # 类型 + 日志 (pino) + 配置
└── tracking/             # 活跃度 + 情绪 + 关系 + 声望 + 行为角色 + ASI + 结果追踪
prompts/                  # AI Prompt 模板 (Markdown)
├── identity/             #   人格：persona.md（身份）+ behavior-style.md（回不回）
├── safety/               #   安全护栏
├── contract/             #   输出格式 (JSON Schema)
├── style/                #   语调风格
├── task/                 #   任务指令 (reply / heart / judge / timing-gate / codeact…)
├── meta/                 #   Meta/Subagent 人设方向 (background-dreaming 等)
└── system/               #   系统级 prompt (摘要等)
migrations/               # SQLite 迁移脚本
packages/nyatdb/          # @nyat/nyatdb 页式引擎（TS；宿主无 Telegram 依赖）
native/nyatdb/            # NyatDB Rust napi addon（可选；https://github.com/ZYHUO/nyatdb）
docs/meta-subagent/       # Meta+Subagent+CodeAct 开关 / 切流 / 日记
docs/nyatdb/              # NyatDB 生产说明
scripts/                  # 安装 / 更新 / 迁移（deploy.sh · install.sh · auto-update.sh · migrate-to-nyatdb.ts）
```

### 🛠️ 技术栈

| 组件 | 技术 |
|------|------|
| 运行时 | Node.js 22+ / TypeScript 5 |
| Bot 框架 | [grammy](https://grammy.dev/) |
| AI SDK | [Vercel AI SDK](https://sdk.vercel.ai/) + @ai-sdk/openai |
| HTTP 框架 | [Hono](https://hono.dev/) |
| 消息队列 | [BullMQ](https://bullmq.io/) (Redis) |
| 数据库 | SQLite ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3), WAL mode) |
| 缓存/队列 | Redis ([ioredis](https://github.com/redis/ioredis)) |
| 向量库 | [Qdrant](https://qdrant.tech/) (HNSW + int8 量化) · 本地嵌入 [@xenova/transformers](https://github.com/xenova/transformers.js) (`paraphrase-multilingual-MiniLM-L12-v2`，384 维；可 `MEMORY_EMBED_MODEL` 覆盖) · 可选 FTS5 BM25 混合检索 |
| 嵌入式 ChatLog（可选） | [NyatDB](https://github.com/ZYHUO/nyatdb)（`@nyat/nyatdb` TS / Rust napi，默认关） |
| 日志 | [pino](https://getpino.io/) |
| 校验 | [zod](https://zod.dev/) |
| Token 计算 | [tiktoken](https://github.com/openai/tiktoken) |
| 构建 | [tsup](https://tsup.egoist.dev/) |
| 测试 | [vitest](https://vitest.dev/) |
| 部署 | Docker / PM2 |

### 🚀 快速开始

#### 前置要求

- Node.js ≥ 22
- Redis ≥ 7
- Telegram Bot Token（从 [@BotFather](https://t.me/BotFather) 获取）
- OpenAI 兼容 API 密钥（OpenAI / Google Gemini / Anthropic / 自建代理等）
- Qdrant 向量库（可选；`scripts/deploy.sh` 会自动下载安装，不配置则语义记忆为空）

#### 🚀 一键部署（推荐，小白也能装）

**最简：一条命令**（自动装 git + 拉源码 + 引导配置，全程问答）：

```bash
curl -fsSL https://raw.githubusercontent.com/ZYHUO/nyat-bot/main/install.sh | sudo bash
```

> 要传参数时用 `-s --`，例如国内镜像：`curl -fsSL .../install.sh | sudo bash -s -- --china`
> 装到别处 / 换镜像：`NYATBOT_DIR=/opt/nyatbot NYATBOT_REPO=https://ghproxy.com/https://github.com/ZYHUO/nyat-bot.git`

或先 clone 再装（等价）：

```bash
git clone https://github.com/ZYHUO/nyat-bot.git && cd nyat-bot
sudo ./scripts/deploy.sh        # 跟着问答走，不用手动编辑任何文件
```

`deploy.sh` / `scripts/install.sh` 是端到端、可重复执行的安装向导：
- **交互填配置**：问你 BOT_TOKEN（用 Telegram `getMe` 当场验证、自动填用户名）+ 一个 AI 接口（自动铺到所有用途）→ 写好 `.env`（权限 600）。配置没填好不会假装成功。
- **环境自检/自愈**：架构(x86_64/ARM64)、Node 22(可自动装)、编译工具、**可选 Rust**（编 [NyatDB](https://github.com/ZYHUO/nyatdb) native；不装则用 TS 引擎）、内存/swap、磁盘、Redis(必需，可自动起)。
- **装好一切**：依赖 → Qdrant(musl 静态版 + systemd) →（可选）`npm run build:nyatdb` → 构建 → systemd → **红绿灯自检**(Qdrant/Redis/服务/Bot started)，结尾给脱敏 `deploy-report.txt`。

```bash
sudo ./scripts/deploy.sh --update        # 秒级更新：git pull + 重建（含 NyatDB native 如有 Rust）+ 重启
sudo ./scripts/deploy.sh --doctor        # 只体检，不改动
sudo ./scripts/deploy.sh --reconfigure   # 重填 token / AI 配置
sudo ./scripts/deploy.sh --uninstall     # 停服并移除单元（保留数据）
```
更多标志：`--dry-run`(预览不执行) `--yes`(非交互) `--china`(国内 npm 镜像) `--minimal`(低内存最小部署) `--skip-{qdrant,build,deps}` `--no-restart`。
墙内：下载被挡时 `export HTTPS_PROXY=…`，或手动下好 Qdrant 包用 `QDRANT_TARBALL=/path`；嵌入模型可设 `HF_ENDPOINT=https://hf-mirror.com`。

#### 日常更新

```bash
# 手动（推荐）：pull + 依赖 + 可选编 NyatDB native + 构建 + 重启
sudo ./scripts/deploy.sh --update
# 或：curl -fsSL https://raw.githubusercontent.com/ZYHUO/nyat-bot/main/install.sh | sudo bash -s -- --update
```

生产机也可挂 `scripts/systemd/xxb-autoupdate.{timer,service}`（每 5 分钟对齐 `origin/main`）：`package-lock` / `native/nyatdb` 变了会 `npm ci` / `npm run build:nyatdb`，主构建失败自动回滚不重启。日志：`logs/auto-update.log`。

#### 手动安装

```bash
git clone https://github.com/ZYHUO/nyat-bot.git
cd nyat-bot
npm install
# 可选：编译 NyatDB native（需 Rust；不编则用 TS 引擎）
#   curl https://sh.rustup.rs -sSf | sh && npm run build:nyatdb
cp .env.example .env
# 编辑 .env，填入你的 Bot Token 和 AI API 配置
# 可选开启 Meta：META_SUBAGENT_ENABLED=true（建议先设 META_SUBAGENT_CHAT_IDS 灰度）
# 详见 docs/meta-subagent/
# 可选开启 NyatDB：NYATDB_ENABLED=true（建议先 DUAL_WRITE，再考虑 READ）
# 引擎独立仓库：https://github.com/ZYHUO/nyatdb
```

#### 从 PHP 版 (xxb) 迁移数据

- **群组知识库**：将 PHP `paths.knowledge_base` 目录下各 `{chatId}.md` 复制到本项目的 `KNOWLEDGE_BASE_DIR`（默认 `./data/knowledge`）。全局永久知识仍使用 `prompts/knowledge/permanent.md`（与 PHP 的 `permanent_knowledge.md` 可手工合并或择一维护）。
- **双写禁忌**：若 TS 与 PHP 暂时共用同一知识库目录，只应在一侧启用 **定时知识库同步**（`KNOWLEDGE_CRON_CHAT_IDS` + cron）；避免两侧同时跑 `cron_long_term` 与本项目的 `knowledge-sync`。
- **人设**：可选将 PHP `persona_path/{userId}.txt` 复制为 `prompts/persona/{userId}.txt` 或 `.md`（或通过 `PERSONA_DIR` 指向原目录）。

#### 开发

```bash
npm run dev            # tsx watch 热重载
npm run build          # 生产构建
npm run build:nyatdb   # 可选：编 Rust ChatLog 引擎（需 Rust；不编则用 TS）
npm run start          # 启动生产服务
npm run test           # vitest 运行测试
npm run lint           # ESLint 检查
```

#### Docker 部署

```bash
docker compose up -d    # 启动 Redis + Bot
```

#### systemd 部署

优先用上面的一键脚本 `sudo ./scripts/deploy.sh`（它会装好 Qdrant + 两个 systemd 服务）。手动等价步骤：

```bash
npm run build
npm run build:miniapp
sudo ./scripts/install-systemd.sh   # 安装 xxb-ts.service（日志写 logs/app.log）
# Qdrant 向量库（语义记忆）— deploy.sh 已自动处理；如需单独装：
#   下载 musl 静态版到 /usr/local/bin/qdrant，套用 deploy/systemd/qdrant.service.template
sudo systemctl restart xxb-ts
sudo systemctl status xxb-ts qdrant
```

常用命令：

```bash
sudo systemctl restart xxb-ts        # 重启 bot
sudo systemctl status xxb-ts qdrant  # bot + 向量库状态
journalctl -u xxb-ts -f              # 或 tail -f logs/app.log
```

#### PM2 部署

```bash
npm run build
pm2 start ecosystem.config.cjs --env production
```

PM2 仅建议作为备用手动方案保留；正式常驻运行优先使用 systemd。

### ⚙️ 配置

所有配置通过环境变量管理，参见 [`.env.example`](.env.example)。核心参数：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `BOT_TOKEN` | Telegram Bot Token | (必填) |
| `AI_PROVIDER_<NAME>_*` | Provider 定义：`ENDPOINT`/`KEY`/`MODEL`/`REASONING`(none/low/…)/`TIMEOUT`/`RAW` 等 | — |
| `AI_USAGE_<ROLE>_LABEL` / `_BACKUPS` | Usage 路由：reply / judge / vision / summarize / reply_pro 各自的主备链 | — |
| `AI_API_KEY` | AI API 密钥 | (必填) |
| `AI_MODEL_REPLY` | 回复用模型（兼容旧式简化配置；实际路由以 provider/usage 为准） | `gpt-4o-mini` |
| `AI_MODEL_JUDGE` | 判断用模型（同上） | `gpt-4o-mini` |
| `REDIS_URL` | Redis 连接地址 | `redis://127.0.0.1:6379/0` |
| `HEDGE_DELAY_MS` | Hedged request 延迟（0=关闭） | `2000` |
| `CONTEXT_MAX_LENGTH` | Redis 上下文最大消息数 | `600` |
| `BOT_NICKNAMES` | Bot 昵称（逗号分隔） | `xxb,啾咪囝` |
| `MASTER_UID` | 主人 Telegram UID | `0` |
| `ALLOWLIST_ENABLED` | 启用群聊白名单 | `false` |
| `ALLOWLIST_BOT_FLOW_ENABLED` | 白名单 bot 对话流（DM 申请 + AI 自动审核 + Master DM 评判） | `false` |
| `ALLOWLIST_REVIEW_ON_JOIN` | bot 被拉进群即自动跑一遍 AI 审核（拉群人是群管理才可自动启用） | `false` |
| `GEMINI_API_KEY` | Gemini 联网搜索 key（AI Studio）；空=回退 xAI/DDG | (可选) |
| `GEMINI_SEARCH_MODEL` / `GEMINI_SEARCH_PROXY` | 搜索模型 / 出口受限时的代理 | `gemini-2.5-flash-lite` / — |
| `FIRECRAWL_API_KEY` / `FIRECRAWL_API_URL` | 抓取兜底（自托管可填 localhost） | (可选) |
| `RESIDENT_STICKER_PACKS` | 常驻贴纸包 set_name（逗号分隔） | (可选) |
| `META_SUBAGENT_ENABLED` | 启用 Meta+Subagent+CodeAct 编排 | `false` |
| `META_SUBAGENT_CHAT_IDS` | 灰度 chatId（逗号分隔；**空=全开**，所有 graylist flag 统一语义） | (空=全开) |
| `META_TICK_MS` / `META_USAGE` | Meta loop 间隔 / 廉价模型 usage | `5000` / `judge` |
| `TIMING_GATE_TIMEOUT_MS` | Heart/gate 每跳 LLM 预算（主+hedge 共享） | `15000` |
| `SUBAGENT_MEMORY_ENABLED` | Subagent CodeAct 注入长期记忆段（隐私由 visibility 层 scrub 兜底） | `true` |
| `REFLECTION_ENABLED` / `REFLECTION_INTERVAL_MIN` / `REFLECTION_WINDOW_MSGS` | 深度反思 cron（每群滚动近况→注入 [本群近况]）；全灭时打 `STARVED` 告警 | `true` / `10` / `200` |
| `CODEACT_USAGE` / `CODEACT_MAX_TURNS` | Subagent CodeAct 模型与轮数 | `reply` / `6` |
| `CONTEXT_ENGINE_ENABLED` | Context Engine 分段组装 | `true` |
| `DREAM_JOURNAL_ENABLED` | 梦境日记 cron（可发频道） | `false` |
| `DREAM_JOURNAL_CHAT_ID` | 日记发送目标（频道/群，可写正数自动转 `-100…`） | `0` |
| `NYATDB_ENABLED` | 启用 [NyatDB](https://github.com/ZYHUO/nyatdb) 嵌入式 ChatLog | `false` |
| `NYATDB_DUAL_WRITE` | 写入 ChatLog（历史名；`REDIS_MIRROR=false` 时是唯一写） | `false` |
| `NYATDB_READ` | 读路径优先 NyatDB（空则回退 Redis） | `false` |
| `NYATDB_REDIS_MIRROR` | 同时写 Redis ctx（`DUAL_WRITE` 开时生效） | `false` |
| `NYATDB_NATIVE` | 用 Rust addon（需先 `npm run build:nyatdb`） | `false` |

> 实际模型路由用 `AI_PROVIDER_<NAME>_*` + `AI_USAGE_<NAME>_*`(provider/usage 分离,Redis `xxb:admin:model_routing:override` 可运行时覆盖);上表 `AI_*` 为兼容旧式简化配置。功能开关一律 `*_ENABLED`(默认关,灰度上线):如 `SCHOOL_SCHEDULE_ENABLED` / `SLEEP_DM_ENABLED` / `PM_NUDGE_ENABLED` / `META_SUBAGENT_ENABLED`。编排与日记详见 [`docs/meta-subagent/`](docs/meta-subagent/)；NyatDB 详见 [`docs/nyatdb/README.md`](docs/nyatdb/README.md)。

### 📊 Prompt 体系

**写回复**（`prompt-builder`）仍是 5 层叠装：

| 层级 | 文件 | 用途 |
|------|------|------|
| L1 Identity | `prompts/identity/persona.md` | 人格身份（主人/认人/日程/优先级） |
| L2 Safety | `prompts/safety/guardrails.md` | 安全护栏（拒绝有害内容、防注入） |
| L3 Contract | `prompts/contract/reply-schema.json` | JSON Schema 输出格式约束 |
| L4 Style | `prompts/style/tone.md` | 语调风格（短句、群聊风格） |
| L5 Task | `prompts/task/reply.md`（+ `reply-pro` / `reply-max`） | 任务指令；按 `replyTier` 叠加深层 |

**接不接话**（决策层）与写作拆开，避免把整份人设塞进 Timing/Heart：

| 用途 | 文件 | 说明 |
|------|------|------|
| 参与准则 | `prompts/identity/behavior-style.md` | 只答「回不回 / 什么时候回」；Timing Gate 主用 |
| 心流 | `prompts/task/heart.md` + persona 身份段 + behavior-style | Heart 一次调用决定 reply / wait / pass |
| 三级判断 | `prompts/task/judge.md` | Heart 关闭时的回退；含 `normal` / `pro` / `max` |
| 节奏门 | `prompts/task/timing-gate.md` | continue / wait / no_action |
| CodeAct | `prompts/task/codeact-reply.md` | Meta→Subagent 写手人格层 |

Prompt 文件进程内热缓存，改完重启即生效，无需重新构建。

### 💬 命令速查

斜杠命令，或用**自然语言**触发（私聊任意意图、群里需 @ 或回复本喵）：

| 命令 | 说明 | 自然语言示例 |
|------|------|------|
| `/checkin` | 每日签到（连签/排名/里程碑，免费解锁猫娘卡） | 「帮我签到」「打卡」 |
| `/stats` | 群聊签到排行榜 | 「看看签到排名」 |
| `/cards` | 我的猫娘图鉴 | 「看看我的图鉴」 |
| `/wish` | 心愿单 `add 卡名` · `holders` 找持有人 · `wanted` | 「我想要九尾喵」「谁有我想要的卡」 |
| `/game` | 小游戏 `tod`/`dare`/`wyr`/`nhie`/`guess` | 「玩真心话」「来个二选一」 |
| `/watch` `/unwatch` `/watches` | 关注目标（DM） | 「追踪比特币」→ 立目标到点跟进 |
| `/muteme` `/unmuteme` | 让本喵不回复我 / 恢复 | 「别理我」「可以理我了」 |
| `/feature` | 群功能开关（群管） | — |
| `/remember` | 记住我的偏好 | 「记住我喜欢猫」 |
| `/help` | 帮助 | 「你会什么」 |

**私聊专属**：传话、匿名纸条、树洞、缘分签、定时提醒、群友档案 —— 直接用自然语言说即可（"帮我跟群里说…"、"纸条 给XX …"、"明天早上6点叫我"）。

### 🔐 安全特性

- **Telegram WebApp HMAC-SHA256 认证** — constant-time 比较防时序攻击
- **SSRF 防护** — 私有 IP / DNS 重绑定检查，skill HTTP 调用同样受保护
- **路径遍历防护** — fileUniqueId 正则校验
- **Redis Lua 原子操作** — 速率限制 + 上下文修剪无竞态
- **NX 去重锁** — 提交 + 结果双重去重
- **API Key 剥离** — 前端响应永远不暴露密钥
- **响应体限制** — web-fetch 工具 512KB 上限防内存溢出
- **Skill 安全沙箱** — script 类型禁用（RCE 防护），HTTP skill 内置 SSRF 过滤，名称白名单校验

### 🔧 工具系统

Bot 可在回复时调用以下工具：

| 工具 | 说明 |
|------|------|
| `WEB_SEARCH` | 联网搜索（Gemini Google-Search grounding 主路由 → xAI / SearxNG / DuckDuckGo 回退） |
| `WEB_FETCH` | 抓取网页内容（直连 → 本地浏览器绕过 → Jina Reader → Firecrawl 自托管兜底；HTML→文本） |
| `BOT_KNOWLEDGE` | 查询群组 bot 知识库 |
| `IP_QUALITY` | IP 地址质量/风险查询 |
| `SET_TIMER` | 设置定时提醒 |
| `LIST_TIMERS` | 列出当前定时器 |
| `DELETE_TIMER` | 删除定时器 |

### 🔌 Skill 插件系统

在 `data/skills/` 目录下放置 JSON 文件即可添加自定义工具，无需修改源码：

```json
{
  "name": "WEATHER",
  "description": "查询指定城市的天气信息",
  "parameters": {
    "city": { "type": "string", "description": "城市名称" }
  },
  "execute": {
    "type": "http",
    "url": "https://wttr.in/{{city}}?format=j1",
    "method": "GET",
    "resultPath": "current_condition.0"
  }
}
```

支持 `type: "http"`（HTTP 请求，内置 SSRF 防护）。详见 `data/skills/README.md`。

---

## English

### Overview

xxb-ts (NyatBot) is a Telegram group chat AI bot written in TypeScript. It acts as an opinionated, cat-girl-themed group member that can:

- **Orchestrate with Meta + Subagent** (optional, default off) — Attention → Meta CodeAct → dispatch → Subagent host APIs → callback; graylist via `META_SUBAGENT_CHAT_IDS` (see [`docs/meta-subagent/`](docs/meta-subagent/))
- **Keep a dream journal** — nightly cron writes `data/dream-journal/` and can post to a channel (`DREAM_JOURNAL_*`)
- **Decide with one heart** — a single persona-aware "heart" call (with a first-person self-state narration) decides reply / wait / pass for passive group messages; optional post-decision "念头" reflection; the 3-level judge pipeline remains as the fallback (Meta graylist chats skip this path to avoid double replies)
- **Think in turns** — MaiBot-style per-chat cognition turns: message bursts judged as one thought, mid-generation interrupts trigger a replan, "wait for them to finish" genuinely comes back, bounded self-continuation
- **Carry a conversation naturally** — stays engaged after it speaks (MaiBot-style talk-frequency): picks up questions/statements from either side within the last few messages, no @ or reply needed, while staying restrained in hot chats
- **Understand natural-language commands** — "帮我签到" → checkin, "看看我的图鉴" → card album, "追踪比特币" → follow-up goal (DM is lenient; groups require addressing the bot)
- **Reply to multiple people** in a single trigger, each quoting its own target
- **Call tools** — web search (Gemini Google-Search grounding → xAI / SearxNG / DDG fallback), web fetch (with self-hosted Firecrawl fallback for JS/Cloudflare pages), IP lookup, timers
- **Live a real life** — 16-year-old high-schooler persona: deterministic weekly timetable + holiday/make-up overrides; sneaks the phone in class (short replies), chattier after school, a daily "today's mood" line
- **Affinity-driven proactive DM** — cross-group affinity (√-weighted, not naive sum); bedtime/wake whispers to high-affinity users who've DMed before; gated group "@ come pm me" nudges for high-affinity strangers (≤3 tries, daily cap, allowlist/mute/membership/sleep gates, off by default); saved-up things flushed when they DM
- **Stream responses** with typing indicators and progressive message updates
- **Remember & learn** — durable nickname memory, importance-scored memory with forgetting, group jargon mining, 7-section user profiles, self-scored reply quality (ASI) feeding a self-tuning humanizer
- **DM assistant** — relay messages to the group, anonymous notes (with a guess-the-author mini-game), tree-hollow confide, fate draws, natural-language reminders, member profiles
- **Collect & play** — free (non-gacha) collectible cat-girl cards unlocked by checking in, wishlist-matched trading, and party games
- **Track group social state** — per-chat mood, decaying per-user affinity, reputation, behavioral roles, and reply-outcome tracking
- **Handle concurrency** via BullMQ job queue backed by Redis; auto-failover ingress (long polling ⇄ webhook)
- **Humanize replies** — typo injection + edit correction, read delay, ack prefix, delete-resend, sticker-only short replies, thinking interjections, afterthought edits, typing indicator alignment, random jitter, smart segmentation

### Key Design Decisions

- **AI-provider agnostic** — Uses [Vercel AI SDK](https://sdk.vercel.ai/) with OpenAI-compatible endpoints. Works with OpenAI, Google Gemini, Anthropic, or any compatible proxy.
- **Dual path cognition** — default Heart/Turn Actor pipeline, or optional Meta+Subagent CodeAct loop (mutually exclusive per chat graylist).
- **Dual storage + optional NyatDB** — Redis for hot data (context, rate limits, member registry) + SQLite for cold data + optional [NyatDB](https://github.com/ZYHUO/nyatdb) page-store ChatLog (dual-write / read, default off; Rust napi or TS engine).
- **Context Engine** — `static|delta|ephemeral|volatile` assembly with a stable prefix for prompt-cache-friendly providers.
- **Split prompt system** — Reply path keeps 5 layers (Identity / Safety / Contract / Style / Task). Decision path uses a slim `behavior-style.md` for Timing/Heart so “whether to speak” isn’t stuffed with full persona prose. All prompts are Markdown; edit + restart, no rebuild.
- **4-way context retrieval** — Recent window + reply thread trace + entity mentions + semantic search (future), merged and token-budget-capped.
- **Graceful shutdown** — BullMQ worker drains active jobs before the bot instance is destroyed.

### Quick Start

One-shot (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/ZYHUO/nyat-bot/main/install.sh | sudo bash
# later: … | sudo bash -s -- --update
# or:    sudo ./scripts/deploy.sh --update
```

Manual:

```bash
git clone https://github.com/ZYHUO/nyat-bot.git
cd nyat-bot
npm install
# optional native ChatLog engine (needs Rust): npm run build:nyatdb
cp .env.example .env
# Edit .env — optional Meta: META_SUBAGENT_ENABLED (see docs/meta-subagent/)
# optional NyatDB: NYATDB_ENABLED / DUAL_WRITE / READ (see .env.example)
npm run build && npm start
```

Or with Docker (TS NyatDB engine only; enable via env — no Rust native in the image):

```bash
docker compose up -d
```

See the [Chinese section](#中文) for detailed configuration and architecture documentation. Engine repo: https://github.com/ZYHUO/nyatdb

### Tech Stack

Node.js 22+ · TypeScript · grammy · Vercel AI SDK · Hono · BullMQ · SQLite · Redis · Qdrant · [NyatDB](https://github.com/ZYHUO/nyatdb) (optional) · pino · zod · tiktoken · tsup · vitest · Docker / PM2
---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
