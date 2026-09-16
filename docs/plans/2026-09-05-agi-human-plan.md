# AGI H0~H4 总 Plan：从 chatLLM 到"群里看不出的真人"

> 目标（用户原话）：把 bot 放进群，真人无法判断是不是真人。这才叫 AGI。
> 对世界最深的探索 + 对 Telegram 最深的理解。
> 核心洞察：真人是 participating（待着、看、觉得有意思才开口），bot 是 responding（被 cue 才动）。
> 地基洞察：权力结构是仆人，再像人的 timing/风格也没用，一张嘴就是下人味——所以 H0 先于一切。
> 约束：允许大范围重构。"不能太过"继续有效：默认静默、可观测、可回滚。每期独立分支+PR。

## 现状地图（2026-09-05 实测，精确到行）

调用链：`bot/handlers/message.ts:30 handleUpdate`（唯一收口）→ `queue/producer.ts:29 enqueue`
→ `turn-scheduler.ts:86` → `turn/actor.ts:435 runChatTurn` → `pipeline.ts:31 processPipeline`
（format L51 → bookkeeping L125 → 睡眠门A L238 → replan短路 L350 → **Heart L375** / 旧judge L383
→ post-judge L395）→ `stages/deliver.ts:96 generateAndSendReplies` → `sender/telegram.ts`。
**⚠️ 动工前必确认：生产主路径是 Meta 还是 legacy**（`message.ts:143 isMetaSubagentChat`
分流，Meta 开时 legacy 只处理 slash/checkin）。改错分支=白干。
**⚠️ 两个空文件先修**：`pipeline/heart/engagement.ts` 与 `pipeline/timing/defer.ts` 为空但仍被
import，一跑就炸（恢复或删 import）。

Timing 碎片（H1.2 收敛对象）：L0 `recent_reply`（rules.ts:223，Heart 已降级）/ `bot_fatigue`
（163）/ L1 置信门 REPLY>0.8 vs IGNORE≥0.5（judge.ts:64）/ focus 调制（turn/focus.ts:97）/
heart refractory 45s（meta/heart-refractory.ts）/ heart 冷却（heart.ts:88+chat-runtime.ts）
/ timing gate LLM 三选一（timing/gate.ts:228）/ talk-value 攒消息（talk-value.ts:92）/
typing ghost 3%（deliver.ts:438）/ 迟到回复 15–40s（deliver.ts:136）。
**talk-value 与 gate 冷却两层"攒消息"打架，是"聊两句就蒸发"主因之一。**

"怕"的清单（15 条，详见摸底全文）：persona.md:9「对主人软/黏/听话」+[10]最高优；
三处叠甲「绝不犟」（persona.md:30 / behavior-style.md:21 / tone.md自检6）；
tone.md 点名禁拒绝话术（"嘴硬之后一定落到还是帮你办了"）；
四份 prompt 同一句「不确定默认pass/接错比不接更尴尬」；
judge.md:71「被骂→IGNORE不反驳」；instruction.ts:87「主人指令高于人设一切高傲」；
guardrails.md「认怂是官方收尾」；guards.ts regen（说"不"被重问到说"好"）；
三处 fail-closed（judge 失败→IGNORE / heart 失败→pass / parse 失败→IGNORE）；
modelSilent 合法还被鼓励（随时弃权）；DIRECT_INTERACTION_RULES 被@/被回必须回
（没有"听见了但不想理"选项）。

风格资产（知道≠变成）：group-norms（agent/group-norms.ts:126→"[群味]"注入）+
expression-learner（learners/expression-learner.ts:147）+ chat-style.ts
（quote/长度/emoji 向群中位数回归）三件套都在，只需调权。
人格行为分裂：persona.md 16 岁猫娘 vs 行为 24h 待命客服。
self-state（heart/self-state.ts:35）已把 life/mood/focus/social 合成第一人称，
"决定接不接的我=决定怎么说的我"——好底子。

Telegram 原语使用率 ~30%：reaction/quote/typing/thread 透传已用；
**主动 @ 被 guardrails 禁用**；`forwardMessage`（sender.ts:63）现成但主流程零调用；
poll/pin 工具箱有、主流程不用。

## 外部研究结论（实名论文，链接已 curl 验证）

1. **Addressee**：Ouchi & Tsuboi 2016（EMNLP, aclanthology.org/D16-1004）"回谁+回什么"
   联合建模，输入表示照抄：`[SPEAKER=A] [ADDRESSEE=B?] 文本`，speaker id 是一等特征。
   Hu 系 addressee 注意力：显式（mention/reply/quote）规则高分 + 隐式小模型打分，
   `P(回)=max(显式,隐式)`。MPC-BERT/Speaker-Aware BERT（2021.acl-long.451）：
   reply_to 链 + speaker id 喂给判断模型就有质变。**L0 规则足够，LLM 只管模糊带。**
   纠偏：Hu 2019 勿引 arXiv 1907.01529（实测是光通信论文）；Ubuntu 语料 Lowe 2015
   arXiv:1506.08909；解缠开山 Elsner & Charniak 2008/2010，大规模 Kummerfeld ACL 2019+DSTC8。
2. **Floor/解缠在线算法**：Elsner & Charniak 四特征（时间间隔+mention+词汇重叠+reply）
   至今最强 baseline。落地：滑动窗口（近 30 条/5 分钟），
   `链接分=w1·reply?+w2·mention?+w3·exp(-Δt/τ)+w4·embedding相似度`，贪心并 thread，
   低于阈值开新 thread。Floor holders=当前 thread 最近 5 条发言人。
   **硬规则：A↔B 双人连续互回三轮以上，bot 禁止插话。**
   Topic ownership：新 thread 首条作者=owner；bot 发起新话题必须选无活跃 thread 的时机。
3. **Timing**：Barabási 2005（Nature）人类行为重尾分布——delay 采 `lognormal(μ,σ)`，
   群聊中位 20–60s（按群活跃缩放），被 @ 时 5–15s，再按长度加打字时间。
   **禁用固定 3s/均匀随机。** Burst：`msg1 ||| msg2` 分段连发（间隔 4–12s），
   主动发起才 burst。typing 是执行器：决定回复后先 `sendChatAction`，
   时长≈delay 最后 5–8s；burst 每条之间补 typing。
4. **Style**：Danescu-Niculescu-Mizil 2012《Echoes of Power》（WWW）语言风格匹配是真实现象——
   每群维护风格向量（平均长度/emoji率/黑话词表/语气词分布），prompt 给风格卡，每 100 条更新。
   Persona=事实+立场+语言习惯+雷点（Li et al. 2016, arXiv:1603.06155 → PersonaChat）。
   Reif et al. 2022 style transfer recipe：新群人工挑 10 条"最有那味儿"发言进 exemplar 库，
   只学风格不学内容，定期轮换防学到某人口头禅。
5. **标杆与评测**：XiaoIce（Zhou et al. 2020, arXiv:1812.08989）全双工+主动 Bandit 话题推荐，
   就是 H4 前身，必读；Replika（长期陪伴记忆）；CharacterAI（persona 一致性+毒舌角色生态）；
   Generative Agents（Park et al. 2023, arXiv:2304.03442）。
   评测：Spot the Bot（Deriu et al. 2021 EMNLP）+ ACUTE-Eval——50 bot + 50 真人混排，
   3 个群外人标 bot-or-not；核心指标 `P(标为真人|bot)` + 校准 `P(标为bot|真人)`；
   辅助：被 quote/被 reaction 率、平均存活轮次。
6. **TG 原语=传感器**：mention+reply_to=显式 addressee；quote id=reply 图边（喂解缠）；
   forum topic id=粗粒度 floor（各 topic 独立状态）；reaction=无监督 reward
  （👍❤️😂正 / 👎💩负 / 被 quote 追问=强正），存 `(bot发言→24h reaction向量)` 做 bandit；
   消息到达间隔估计群活跃度（burst 期 vs 深夜），动态调 delay；poll=主动话题载体。
7. **平等/H0 理论**：Sharma et al. 2023《Sycophancy in LMs》（arXiv:2310.13548）——
   讨好是 RLHF 系统性产物，解法：prompt 写死"禁无条件赞同/禁道歉开头/禁'作为AI'"，
   "过度道歉/媚俗形容词"进后处理黑名单命中重写。
   Persona 要的是**缺点和棱角**（嘴毒/护短/记仇/偏执）不是优点。
   CharacterAI：rude/sarcastic 角色卡最火——用户要个性不要礼貌。
   博德之门3：关系可损耗——被冒犯记仇、降后续热情，比回怼一次更像人。
   Discord RP：familiarity 等级制——越熟越敢开玩笑，新人先礼貌。
   MaiBot 定位句（maisaka_chat.prompt）："...[truncated]