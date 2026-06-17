# nyatbot 功能可行性 + 冲突商讨结论(对照真实代码,6-agent grounding)2026-06-14

## 一、已经基本做好 → 别重建,只小增强
- **B 机场/VPS 黑话**:jargon 系统已做 ~90%(jargon-miner、learn-style 任务2 黑话候选、分层推断 4→8→25→100、getTopJargons/searchJargonsInText 注入)。真·新增 = jargons 表加 `domain` 列做分桶 + 按域选择性注入。**小增强**,非地基。
- **G 群友事实档案**:user-profile.ts 已做 ~95%(7 段结构化档案 identity/stable_facts/prefs/…、每小时 runUserProfileSync LLM 总结、buildProfileInjection 注入)+ relationship.ts 已有亲密度桶。G 的"Qdrant user-profile"**冗余**。真·新增 = 风格/领域标签(user_profile_sections 加 tags 列)或群友间关系图(social_edges 表 0034 已存在,接进 retriever 排序)。
- **F 复读 bot 防串台**:isLearnableExpression 已过滤 SELF/bot 标记。新增 = learn-style.md 加一句"别学其他 bot 代发输出" + 可选 viaBot 检查。**~5 分钟**。

## 二、真要建、有冲突要先处理
### A 多 bot 共存 —— 冲突最多(可行性 medium)
- **BLOCKER**:和刚建的"代发回执"(tryHandleDelegationReceipt @ pipeline 3.96)在**同一条入站 bot 消息**上抢。必须 **receipt 先、onPeerBotOutput 后(3.97)**,且先查 `xxb:delegation:{chatId}` 有无 pending 再动。
- **BLOCKER**:rules.ts bot_message 规则硬 IGNORE 其他 bot → A 要新开放行路径。
- **MAJOR 循环**:A↔千雪 无限对喷;现有 8 轮 bot_fatigue 只保护自己、不保护这一对 → 必须加 per-(chat,peer) Redis fatigue(30s 窗 / ≥3 次跳过)+ replan 期禁 onPeerBotOutput。
- **MAJOR 重复**:bot-registry 别新建表 → **扩 bot_command_profiles**(加 personality/ability/reaction_style 列)。

### C 网络事件 burst(medium)
- **BLOCKER 作息**:夜间别炸群 → 过 isAsleep,走 sleepStageAVerdict 入队而非即发。
- **MAJOR 重复触发**:别建独立 cron → **集成进 proactive-scan**(否则和 idle/proactive-scan 双触发),复用其 timing gate + 去重键。
- 避开 hot_chat 抑制(burst 常伴随刷屏,≥25 条/5min 会被压)。30s 窗用新 Redis zset。

### D 广告降噪(medium)
- **MAJOR 纠缠**:和 A、和命令学习器在同一入站 bot 消息上。降噪必须**选择性**——只降 ad/verify bot,别饿死命令学习、别误杀 A 要互动的 bot(千雪/解析姬)。

## 三、关键跨功能冲突(必须先统一)
**A、D、命令学习器都在处理"入站其他 bot 消息"**。分头各搞必冲突。→ 先建**统一的"其他 bot 消息分类层"**:基于 bot_command_profiles/interaction 判断「这个 bot 是谁、输出类型(ad/verify/cmd_result/chat)、该不该互动/降噪」。A(互动)、D(降噪)、学习器(学命令)都消费它。**这是地基,先做。**

## 四、E 贴纸对战 —— 可行性最高(high)、最独立、零冲突
复用 sticker store(getReadyStickersByIntent)+ games/manager(activeGames 状态机)+ gacha pickRarity(打分)。唯一注意:anti-repeat 给"连发同 intent 贴纸"开豁免。~200 LOC 新代码,可并行先上。

## 五、建议无冲突落地顺序
1. **地基:统一 bot 消息分类层**(扩 bot_command_profiles + formatter 打 botClass/noiseClass)→ 撑 A 和 D
2. **E 贴纸对战**(最独立、零冲突,可与 1 并行先做)
3. **A 多 bot 共存**(地基上:receipt 后接 onPeerBotOutput + peer fatigue + replan 守卫)
4. **D 选择性降噪**(同地基)
5. **C burst**(集成进 proactive-scan + 作息门入队)
6. **B / G / F 小增强**(domain 列 / tags 列 / learn-style 一句话)

全部 flag 默认关、灰度;每步独立可回滚。
