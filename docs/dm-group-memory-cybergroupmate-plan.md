验证完毕,三份报告的关键事实与源码一致(chroma.ts:240 强制 chatId 过滤且 payload 无 visibility 字段;person-identity.ts 只取 primary 群画像、chat_count>1 闸;manager.ts:73-77 反向索引仅 chatId<0 收录即结构性排除 DM;user-profile PK=(chat_id,uid);迁移号已到 0046,新迁移从 0047 起)。以下是落地方案。

---

# xxb-ts:打通 DM↔群连结度(尤其记忆)落地方案

## 一、差距诊断:当前隔离的具体表现 vs CyberGroupmate 以人为中心模型

xxb-ts 的根本问题是**一切以 `chatId` 硬分区**,DM 只是"另一个正数 chatId 分区",跨上下文只有几条 per-uid 的薄读模型,且只搬"称呼/好感/一个代表群的画像摘要",不搬记忆内容。对照 CyberGroupmate,差在 5 个具体机制:

| # | 机制 | CyberGroupmate 怎么做 | xxb-ts 现状 | 差距本质 |
|---|---|---|---|---|
| G1 | **身份 = 记忆锚点** | `userId={platform}:{rawId}` 与 chatId 完全解耦,`person_identities` 单行跨 DM+所有群;画像/事实/互动挂在这条身份上按需分裂全局/每群(报告A §1) | 有 `person_identity`(PK=uid),但只是"挑好感最高群的画像摘要"搬运,`getUserGroups` 结构性排除 DM(manager.ts:73-77 仅 chatId<0 才 sadd) | 有身份表,但它**不是记忆的锚点**,只是一个跨群画像缓存;DM 从不进入身份视图 |
| G2 | **两层画像分层** | 全局 `PersonProfile`(traits/interests/style/relation/stablePatterns/policyHints/followup + confidence/sourceChatIds)+ 每群 `PersonGroupProfile`(affinity/tier/recentEpisodes/mergedMemory)。同名字段语义不同,不合并(报告A §2) | 只有 (chat_id,uid) 单层 `user_profiles`/`user_profile_sections`;"全局"仅靠 `getAggregatedUserTag`/`getAggregatedAffinity` 几个读模型拼 | 缺"跨群稳定认知"这一层实体表;DM 画像与群画像互不喂养(报告C §6.6) |
| G3 | **DM 是一等公民** | DM = `isDirectMessage=1` 的一个普通 chat,同构复用 topics/interactions/profile/召回全套;时间线进同一 `interactions` 表(报告A §3) | DM 走完整管线但所有 key=uid,画像用 (chat_id=uid) 专属行,记忆写 Qdrant chatId=uid 分区;与群零共享(报告C §2) | DM 结构上"同构"但**语义上是孤岛**——没有任何跨 chat 聚合读它 |
| G4 | **跨上下文记忆召回** | recall 不传 chatId 时按 userId 跨最多 5 群聚合 group profile;core_facts.subject=composite userId 跨群可检索(报告A §4/§0) | `searchMemory` 每次强制 `filter: chatId match`(chroma.ts:240),无任何跨 chat 入口;facts/episode/MTM 全锁 chatId | **完全没有** per-uid 的跨上下文记忆检索;"我上次在群里说的那事"DM 里召不回 |
| G5 | **隐私 visibility 兜底** | 两层 visibility:chat 级(DM 默认 private)+ fact 级(private/contextual/public);DM 抽的 fact 默认 private,群默认 contextual;跨界读逐行 scrub、写硬报错(报告B §3) | **完全没有** visibility 概念;隔离纯靠 chatId 分区副作用;Qdrant payload 无 visibility 字段(chroma.ts:179-190) | 一旦打通,**没有任何机制阻止 DM 私密内容泄漏进群**——这是打通的前置阻塞项 |

一句话诊断:xxb-ts 已有"认得同一个人"(称呼/好感一致)的薄层,但**缺"记住同一个人跨上下文的事"的厚层**,且缺打通所必需的隐私护栏。

---

## 二、可移植机制(按性价比排序)

> 通用约束(对齐 xxb-ts 约定):全部新行为 env flag 门控、默认关、先灰度群;沿用 Qdrant+SQLite+Redis,**不引入新基础设施**;新迁移从 `0047_` 起;身份键继续用 TG uid(不做 CyberGroupmate 的 composite `{platform}:{id}`——xxb-ts 单平台,uid 已够,报告C §3.4 明确无跨账号归并需求)。

### 机制 1 —— 隐私 visibility 兜底层(前置依赖,必须最先做)

- **借鉴 CyberGroupmate 的**:两层 visibility 模型(报告B §3.1/§3.4)+ 出口 scrub 而非读遮蔽(报告B §3.3)。**只借模型与不变式,不借 chokepoint 架构**(见第四节)。
- **映射到 xxb-ts**:
  - Qdrant payload 加 `visibility: 'private'|'contextual'|'public'` 与保留 `sourceChatId`(=写入时的 chatId)。写入点 `chroma.ts:memorizeMessage`(pipeline.ts:127/189):**DM(chatId>0)写入默认 `private`,群默认 `contextual`**。存量数据无字段 → 检索时按"缺失即视作 sourceChatId 私密性"兜底(与 CyberGroupmate `reflection.ts:1305` 同思路)。
  - 新增纯函数模块 `src/memory/visibility.ts`:`getChatVisibility(chatId)`(chatId>0 即 DM → private)、`scrubMemoryHits(hits, boundChatId)`、`scrubFactsByVisibility`。规则:跨 chat 读到 `visibility==='private'` 或 `isPrivateChat(sourceChatId)` 且 sourceChatId≠boundChatId → 丢弃(双判,防"来自敏感来源但只标 contextual"漏网,报告B §3.4)。
  - 好感/画像的跨群注入(机制 2/4)在返回前统一过一次 scrub。
- **改造范围**:1 个新迁移(Qdrant 无需迁移,payload 加字段即可;SQLite 侧若给画像/fact 加 visibility 列则 1 迁移)+ 1 新文件(~150 行)+ 修改 chroma.ts 写入/检索 2 处。**中小。**
- **风险**:低(默认关时行为不变;开启后只会"少给",不会错发)。**注意**:这是所有跨上下文共享的闸门,机制 2/4 的开关必须依赖本机制已开启,否则拒绝跨 chat 返回。

### 机制 2 —— 全局 PersonProfile / 每群 PersonGroupProfile 分层(核心地基)

- **借鉴 CyberGroupmate 的**:`PersonProfile`(全局稳定认知)vs `PersonGroupProfile`(每群表现+情节)的字段分工(报告A §2.3),以及"同名 traits/interests 不合并、由两条独立 LLM 输出分别产出"的原则(报告A §2.3)。
- **映射到 xxb-ts**:
  - **不新建大表,升级现有 `person_identity`**(migrations 0044)为真正的全局画像:把 `impression`(单一文本)扩成结构化列 `traits/interests/comm_style/relation_to_bot/stable_patterns`(JSON)+ `source_chat_ids` + `confidence`。这是 G2 的全局层落点,复用现有 uid 主键。
  - 每群层沿用现有 `user_profiles`/`user_profile_sections`(PK=(chat_id,uid))——已经是"每群表现",无需动结构。
  - **关键修正 G3**:`getUserGroups`(manager.ts:146)当前只收 chatId<0。新增 per-uid 反向索引把 DM 也纳入(或单独 `getUserContexts(uid)` 含 DM),让全局层能读到 DM 画像。用 flag 控制,避免影响现有 person-identity 逻辑。
  - 全局层的产出**不再是"挑 primary 群摘要"**(person-identity.ts:72 的做法丢弃了非 primary 群+全部 DM),改为"多上下文合并"(见机制 5)。
- **改造范围**:1 迁移(扩 person_identity 列)+ 改 person-identity.ts 刷新逻辑 + 改 getUserGroups/新增 getUserContexts。**中。**
- **风险**:中。person-identity 刷新当前是"廉价确定性无 LLM";若改为多群合并需谨慎 token 与频率(可先做规则合并:traits 取并集去重、affinity 取聚合、relation 取最高群),LLM 合并放机制 5。

### 机制 3 —— DM 作为一等公民接入跨群读模型

- **借鉴**:DM 与群同构、跨上下文聚合靠"同一 userId + 不加 chatId 过滤"(报告A §3.1、报告B §2.2)。
- **映射到 xxb-ts**:
  - 把 DM 纳入 §机制2 的 `getUserContexts(uid)`(反向索引在 chatId>0 时也 sadd,或单独 DM 集合)。
  - 好感聚合 `getAggregatedAffinity`(user-affinity.ts:57)已含 DM 行(报告C §6 已具备),保留;但注入到群时经机制 1 scrub(好感数值本身非私密,可放行)。
  - `buildCrossGroupInjection`(person-identity.ts:88)的 `chat_count>1` 闸放宽:DM 也算一个上下文,则"只在一个群但也私聊过"的用户也能拿到跨上下文连结(修正报告C §6.7 的单群用户拿不到问题)。
- **改造范围**:小(主要是索引口径 + 闸条件),依赖机制 2。**小。**
- **风险**:低-中。放宽后要确保 DM→群方向的注入内容经 scrub(DM 画像里的私密事实不能裸注入群 prompt)。

### 机制 4 —— 跨上下文记忆召回(per-uid,可选放宽)

- **借鉴**:core_facts 以 userId 为 subject 跨群检索 + recall 结构化把命中挂回人(报告A §4.3);向量/FTS 命中内容、结构化 participants/userId 反查挂人。
- **映射到 xxb-ts**:
  - **不改 Qdrant 主检索的默认行为**(仍锁 chatId,保安全)。新增一条**可选**旁路:`searchMemoryByUser(uid, query, {includePrivate:false})`,filter 从 `chatId match` 改为 `uid match`(uid 已在 payload,chroma.ts:179-190,需补 uid payload index),返回后**强制过机制 1 的 scrub**(默认剔除所有 private + 非当前 boundChat 的 contextual)。
  - 接入点:retriever.ts:133 旁边加一路"跨群人物记忆",仅当 flag 开 + 命中的是"关于某个在场用户"的查询时触发;DM 里回答"我上次在群里说的X"走这条(此时 boundChat=DM,群的 contextual 记忆能否带出取决于该群 visibility 与用户授权——保守起见默认只带 public)。
- **改造范围**:中(新增检索函数 + payload index + retriever 接线)。**中。**
- **风险**:中-高。这是最容易泄漏的一环,必须机制 1 先落地且开启;建议最后做、最小灰度。默认 `includePrivate=false` 且跨 contextual 也不带,只带 public,后续再按"用户显式授权"放宽。

### 机制 5 —— 反思/合并同时喂全局与每群(增量收益)

- **借鉴**:reflection 一次跑同时产 `personUpdates`(群内)+ `globalPersonUpdates`(跨群),失败不推进水位线的自适应收缩;episode→week→month 级联合并 + `promoteMergedMemoryToGlobalProfile` 向上汇总(报告A §5.2/§5.3/§5.4)。
- **映射到 xxb-ts**:xxb-ts 现有画像刷新是 per-message 轻量更新,没有 CyberGroupmate 那套 reflection LLM 管线。**不照搬整套**,而是:
  - 在现有 cron(scheduler.ts,已有 6 job)加一个低频 job:对活跃 uid 跑一次"全局画像合并"——把该 uid 各上下文(群+DM)的每群画像 + 聚合好感,喂给便宜模型(gemini,现成路由)产出全局 traits/interests/relation,写回机制 2 的扩展列。**成功才更新 updated_at**(借鉴"失败不推进水位线")。
  - episode 级联合并(week/month)是"锦上添花",xxb-ts 有 group_episodes(0035)但按 chat;可延后或不做。
- **改造范围**:中(新 cron job + gemini 合并 prompt)。**中。**
- **风险**:低-中(默认关;频率与 token 需控;合并只写全局层,不污染每群层)。

---

## 三、分期建议

**Phase 0 — 地基(必须先做,阻塞后续)**
1. 机制 1 隐私 visibility 兜底(Qdrant payload + SQLite 列 + `visibility.ts` + scrub)。**这是打通的前置门,先于任何跨上下文共享上线。**
2. 机制 2 的表结构升级(扩 person_identity 为结构化全局画像)+ `getUserContexts(uid)` 含 DM。
   - 交付即可验证:全局画像表能读到 DM 上下文;scrub 单测覆盖"DM private 不跨群、群 contextual 不裸跨群"。

**Phase 1 — 连结读侧(增量收益,低风险)**
3. 机制 3:DM 纳入跨群读模型 + 放宽 `chat_count>1` 闸(DM 算一个上下文)。
4. 机制 5:低频 cron 全局画像合并(规则合并先行,LLM 合并灰度)。
   - 效果:DM 里 bot 认得"你在群里的整体样子",群里也带上"私聊沉淀的稳定认知"(经 scrub 后的非私密部分)。

**Phase 2 — 跨上下文记忆检索(高价值高风险,最后灰度)**
5. 机制 4:`searchMemoryByUser` 旁路 + retriever 接线,默认只带 public,单群小范围灰度。
   - 效果:"我上次说的那个事"跨 DM/群可召回(在隐私允许范围内)。

每个 Phase 独立 env flag,默认关,先灰度群;Phase 2 必须确认 Phase 0 的 scrub 在生产已稳定运行后才开。

---

## 四、明确不该照搬的部分

1. **Meta/Subagent + CodeAct 分层架构(报告B §1)——不照搬。** CyberGroupmate 是"全局单例 Meta 只调度 + 每 chat 一个持久 Subagent 在 sandbox 跑代码 + dispatch/callback 闭环"的多智能体重架构。xxb-ts 是 per-message/turn-actor 管线(pipeline: formatter→judge→retriever→reply→send),硬移植等于重写核心。**可借的理念**:DM 与群"同一套入口、同构处理"(报告B §2.1)——xxb-ts 已天然如此(DM 走完整管线)。**不可照抄**:Meta 的跨群主动感知/dispatch、runtime.elevate 升级、CallbackQueue 闭环。跨群主动回访若要做,用现有 cron + dm-proactive.ts 机制实现,不引入 agent 循环。

2. **隐私的 chokepoint 实现(报告B §3.3 的 host-call-handler / meta-api 双出口)——不照搬实现,只借模型。** CyberGroupmate 在 sandbox host-call 层和 Meta dispatch 出口两处拦截,因为它有 sandbox。xxb-ts 无 sandbox,scrub 应放在**记忆检索返回处 + prompt 组装处**(retriever.ts、prompt-builder.ts buildPersonalContext:121-146)这两个自然收口点。**借**:两层 visibility 语义、双判 scrub(fact 级 OR 来源 chat 级)、DM 默认 private、"读不遮蔽身份、只擦内容行"的取舍。

3. **composite `userId={platform}:{rawId}`(报告A §1.1)——不照搬。** xxb-ts 单平台(Telegram),TG uid 已是稳定全局键(person_identity PK=uid 已验证)。加平台前缀是无收益的改动面。**保留** xxb-ts 现状。

4. **sqlite-vec / 独立记忆 SQLite(报告A §0)——不照搬。** xxb-ts 已用 Qdrant 做向量、better-sqlite3 做结构化,栈已定。跨群检索用"改 filter 从 chatId→uid + 加 uid payload index"实现(机制 4),不迁移到 sqlite-vec。

5. **CyberGroupmate 的 Dunbar tier 人数上限降级 / episode 级联 week→month→quarter→year(报告A §5.3/§5.4)——非必要,延后或不做。** 收益边际递减,且依赖 reflection LLM 管线。xxb-ts 先做"全局画像规则合并"即可覆盖 80% 连结感;级联合并留待 Phase 2+ 视效果再定。

---

## 关键文件落点速查(供 EnterPlanMode)

- 隐私层(新):`src/memory/visibility.ts`;改 `src/memory/chroma.ts`(179-190 payload 加 visibility/sourceChatId、写入 memorizeMessage、240 检索 scrub)、`src/pipeline/reply/prompt-builder.ts:121-146`(注入前 scrub)
- 全局画像:迁移 `0047_person_profile_global.sql`(扩 person_identity 列);改 `src/tracking/person-identity.ts`(刷新逻辑 55-74、注入 88-98 放宽 chat_count 闸);`src/pipeline/context/manager.ts`(73-77 索引口径、146 getUserGroups→新增 getUserContexts 含 DM)
- 跨群召回:改 `src/memory/chroma.ts`(新增 searchMemoryByUser + uid payload index)、`src/pipeline/context/retriever.ts:133`(旁路接线)
- 全局合并 cron:`src/cron/scheduler.ts`(新 job)+ gemini 合并 prompt
- 好感/称呼(已具备,复用):`src/tracking/user-affinity.ts:57`、`src/tracking/user-profile.ts:226/248`
- 新迁移编号从 `0047_` 起(现有到 0046)