# nyatbot 功能提案(cursor + qoder + codex,基于真实群对话)2026-06-14

三家独立提案,下面是去重综合;原始三份附在文件末尾。

## 共识(三家都提)→ 最高优先

### A. 多 bot 共存 / bot 间互动(对标千雪)★★★
群里 千雪(另一只猫娘)、聚合解析姬、抽奖机器人、复读 bot 共存,本喵现在把它们当噪音、全程缺席(群3 千雪连珠接梗,本喵 0 条)。
- 让位 / 捧哏 / 补刀 三态;解析姬发完下载结果 → 本喵补一句极短吐槽("睦头人正方形了喵");千雪说话 → 偶尔"千雪又在装了喵"。
- 接法:bot-registry(username+人格标签+能力+输出类型)+ onPeerBotOutput hook + turn-actor 的 bot-presence signal(让路窗口/冷却);relationship 存"和千雪相声次数"调让位概率。

### B. 机场/VPS 黑话 domain 模式 ★★★
本喵活在技术群,"草原拨号味/包喂猫了"是撞运气。表达学习应**按 domain 分桶**(infra/梗),听懂"节点延迟/丢包/家宽/全红/三网绕"并用同样行话短回。
- 接法:expression-learner 加 domain 标签 + lexicon 子表(频次+共现提取术语);reply prompt 注入 [机房口癖];走 direct 不查资料。

### C. 网络事件 burst 触发 ★★
机场/VPS 群核心是线路状态。多人同时刷"挂了/断线/CF炸了/502" → 滑窗 burst 检测(30s/≥3 同主题)→ 主动一句("又炸了?本喵看看"),可选接 ping/http 轻探针喂写手。

## 强单点提案

### D. bot 广告/验证降噪(省钱)★★
nmBot 入群验证 + Another 机场广告连发污染上下文、浪费 judge token。formatter 标 noiseClass=bot_ad|verify → retriever 权重 ×0.3 + path-heuristic 硬 pass,极低概率 meta 一句。

### E. 贴纸语义 / 贴纸对战
贴纸是半个群语言,本喵只会随机跟发。codex:给贴纸建 embedding/标签(语境:嘲笑/震惊/晚安/赢麻),允许"短句+贴纸"且 anti-repeat。qoder:连续贴纸 → 贴纸 PK 小游戏(复用卡牌随机打分)。

### F. 复读 bot 防串台
妙妙小工具"黑幕!黑幕!""咕咕嘎嘎!"三连复读,表达学习若吸收会变 bot 套娃第四层。bot-profile 标 output_type=echo → anti-repeat + 禁同短语接龙,改贴纸/沉默。

### G. 群友事实档案
relationship 偏情感数值,缺"我记得你纠结哪个机场方案"。Qdrant user-profile 集合(chatId+userId,风格/领域/常聊话题/关系阶段)+ 中期压缩里加 profile 提取轮,回复前检索注入。

## 建议落地顺序
1. **A 多 bot 共存** + **D 广告降噪**(一对:都靠 bot-registry/bot 来源识别,一起做最省;A 提存在感、D 省成本)
2. **B 黑话 domain 桶**(表达学习现成,加标签即可,收益直接)
3. **C 事件 burst**(复用话题追踪+burst)
4. E/F/G 看反馈再排

---
# 原始三份

## codex
(见上方综合,原文略)
