# MaiBot vs xxb-ts 语言生命层差距(已验证)

> 2026-06-10,16 代理工作流:4 深读(MaiBot 表达学习 / 记忆人物 / prompt 解剖 + xxb 对照)→ 10 条差距全部经对抗验证(含**线上 DB 实查**)。
> 背景:主人体感"MaiBot 吃到黑话、常驻后更像人;nyatbot 差很多,不只是 persona prompt"。回复框架(回合/打断/动作空间)已移植,不在本篇范围。

## 一句话结论

**体感差距的根源不是缺机制,是我们的学习闭环在数据层断了**:黑话表 1057 条全部 count=1(增量扫描让每条消息只被见一次,计数永远到不了推断阈值 4)→ 0 条被推断 → `[本群黑话]` 块从未发火;表达表 1606 条只有 10 条曾被强化(ON CONFLICT 要求字节级相同)→ "top 表达"基本是随机噪音。**bot 住了几周,实际消化的群语言 ≈ 0**。MaiBot 的同款管线是真闭环:LRU 重检计数 → 阈值推断 → 加权采样 → 软性格式注入 → 使用强化。

## 差距清单

| # | 影响/工作量 | 内容 | 根因/修法 |
|---|---|---|---|
| **G1** | critical/M | **黑话管线结构性死亡**:1057 条全 count=1、0 条 inferred、注入块从未发火 | learner-scan 只喂 `messageId>lastMsgId` 的新消息 → 同词永不复现 → count 不可能爬 → 推断永不触发。修:每 tick 把新 batch 与本群已存黑话做子串匹配补计数(对标 MaiBot LRU 重检);阈值 4→3;存量回填 |
| **G2** | high/M | **表达强化死于精确匹配**:1606 条仅 10 条 count>1 | ON CONFLICT(situation,style) 要求字节级相同。修:插入前与现存做相似度(复用 anti-repeat 的 bigram ratio,阈值 ~0.75),近似 → 合并强化而非新插 |
| **G3** | medium/S | 注入格式是干巴数据表(`situation → style`),MaiBot 是软性习惯框架("当X时,可以自然地用Y说法,不必每条都用") | 改 prompt 格式 |
| **G4** | high/M | 学到的语言素材埋在几千 token 的状态提示中间 | `[本群常用表达]`/`[本群黑话]` 挪到 CURRENT_MESSAGE 紧前(最高 recency);低价值块按内容丰富度门控 |
| **G5** | medium/S | tone.md 只有泛用反 AI 腔,没有"主动用群里自己的说法/梗"的指令 | 加一句,与 G3 配套 |
| **G6** | high/M | selector 池子是平的(全是 count=1 噪音),且只在 rich-context 跑;无使用强化 | G2 之后按 count 加权;被选中注入时 count++(MaiBot 的 use-based 强化);normal 路径也走 count 排序 |
| **G7** | medium/L | **无群共同经历记忆**:per-user 记忆很深(被驳回的 G11 证明印象层反超 MaiBot),但"上周群里那件事"不存在 | group_episodes 表 + 小时级摘要 cron + 语境命中注入 |
| **G8** | medium/S | 黑话只有"注入 top5"一个方向;MaiBot 还有 query_jargon 理解侧(看到不懂的词先查) | G1 解锁后:入站消息与本群黑话子串匹配 → 命中的含义随消息注入;prompt 教"不懂先查" |
| **G9** | medium/S | learn-style 只在 prompt 里说"别学 SELF 发言",无程序级过滤 → **bot 可能在学自己的话(回音室)**;无单批上限 | parseLearnerOutput 后置硬过滤(SELF/bot名/媒体占位);单批 cap |
| **G10** | low/S | 无衰减/清理:1595 条单次表达 + 1057 条死黑话永久稀释注入池 | 注入池 count>=2 优先(池够大时);月度 prune |
| ~~G11~~ | 驳回 | "人物印象是数字而非自由文本叙事" — **反向**:xxb 的 7 桶 profile sections + 角色 + 关系叙事比 MaiBot 更深 | 无需动作 |

## MaiBot 闭环要点(对标参考)

- 表达 = (situation→style) 对,LLM 从真实群聊蒸馏,自审门 + difflib 0.75 合并 + count/recency 强化,回复时从 count>1 子集加权采样,注入为"可以自然地用…"软引导,**非逐字模仿**
- 黑话与表达共用一次抽取 LLM;黑话靠 50 条 LRU 在新消息里**重检计数**;阈值 {4,8,25,100} 三调用一致性推断含义;含义不自动注入,由 reply 模型用 query_jargon 工具按需查
- v1.0 反而**没有**衰减(纯加性 count++)——我们不必神化它,但闭环必须先通

## 实施状态(2026-06-10 当天全部实施)

| Gap | 状态 | 备注 |
|---|---|---|
| G1 黑话死管线 | ✅ | recountJargonsInMessages 重检计数(对标 MaiBot LRU)+ 阈值 4→3 + 存量回填(74 词条立即过线,推断 cron 已开始消化) |
| G2 表达模糊合并 | ✅ | bigram 相似度 ≥0.7 合并强化,不再要求字节级相同 |
| G3 软性习惯框架 | ✅ | "当X时,可以像群友那样说:「Y」" |
| G4 注入位置 | ✅ | [表达习惯参考] 挪到 CURRENT_MESSAGE 紧前 |
| G5 使用指令 | ✅ | tone.md 群的语言一节 |
| G6 使用强化 | ✅ | 注入即 count++(静态与 selector 两路) |
| G7 群共同经历 | ✅ | group_episodes 表(0035)+ 每 2h 摘要 cron + 关键词召回注入 [群里的往事],召回即强化 |
| G8 黑话理解侧 | ✅ | searchJargonsInText:入站消息命中已学黑话 → [消息里的黑话] 含义注入 |
| G9 SELF 硬过滤 | ✅ | 程序级过滤 SELF/bot名/媒体占位 + 单批 cap 8 |
| G10 池地板+清理 | ✅ | count>=2 优先注入;90/60 天 prune 挂 cleanup cron |

