# MaiBot vs xxb-ts 回复框架差距分析(已验证)

> 2026-06-05,多代理工作流产出:4 个深读代理(xxb-ts 管线 / MaiBot 核心 / MaiBot 投递层+TG适配器 / 设计文档)→ 综合出 13 条框架级差距 → 每条由独立对抗验证代理在 xxb-ts 源码中复核。
> 研究对象:MaiBot v1.0 "MaiSaka"(/root/.tmp-maibot-study)+ Go Telegram 适配器(/root/.tmp-maibot-tg-adapter)。

## 一句话结论

**xxb-ts 是"刺激-反应"管线:一条消息进来 → 一次判断 → 一次生成 → 投递,结束。MaiBot 是"驻场思维":每个群一个常驻异步循环(observe → timing-gate → plan → act,内部最多 10 轮),说话只是规划器可选的工具之一,沉默、等待、继续、表情包都是一等公民动作,新消息可以中途打断并触发重新规划。** xxb-ts 所有"像人"的效果(错别字/延迟/撤回/贴纸替换)都是文本生成之后的独立骰子,模型本人毫不知情——这正是"演人"和"是人"的区别。

## MaiBot 当前架构(MaiSaka,v1.0)

- 每个会话一个长驻 asyncio 任务(`MaisakaHeartFlowChatting` + `MaisakaReasoningEngine.run_loop`);入站消息只做三件事:落库、注册到 message_cache、唤醒循环
- **触发层**:按 talk_value 折算"需积累 N 条消息"阈值 + 空闲补偿(沉默时间折算成等效消息数);@/提及强制立即开轮
- **Timing Gate**(廉价 LLM):只选 {continue, no_action, wait} —— 决定"现在是不是说话的时机"
- **Planner**(主 LLM):先自由文本推理,再发工具调用:{reply, send_emoji, send_image, query_memory, tool_search, wait, finish, continue, ...};**说话只是工具之一**
- **Replyer 子代理**:表达选择器(加权采样学到的风格片段)→ 生成 → after_response 钩子可置 retry 强制带约束重生成 → difflib 反重复守卫(>0.9 相似强制重想)
- **打断**:planner 流式请求期间新消息置 interrupt 标志 → `ReqAbortException` 丢弃在飞决策 → 1s 静默期 → 重新锚定最新消息重规划(有连续打断上限)
- **wait 是真等待**:计时器到点注入 timeout 触发,**自己回来接着想**,无需新消息
- **投递**:核心按句切分、注入错别字、每段按字数模拟打字延迟逐条发送,只有第一段带引用;Go TG 适配器反而是哑管道(把分段拼成一条发——TG 适配器比核心差得多)

## 13 条差距(全部经源码验证)

### 🔴 根本性

**G1【critical/XL】没有每群持续 observe→plan→act 循环**(real)
- xxb: 每条更新一个 BullMQ job,全局 FIFO 队列 concurrency 8,无 per-chat actor(producer.ts:31, worker.ts:44, pipeline.ts:1138)
- 后果:不能让几条消息积累成一个完整念头、不能自主节奏分批行动、没有"我此刻在场"的概念。其余差距(G3/G4/G6)全部源于此
- 移植:BullMQ jobId 去重做 per-chat `turn-{chatId}` 延迟任务 = 无连接的回合 actor;ingress 只写 `xxb:pending:{chatId}` + scheduleTurn() 续期防抖;回合体复用现有管线各阶段

**G2【critical/XL】动作空间只有文本,社交动作是事后骰子**(partial —— 验证纠偏:timing gate 已是 MaiBot Stage-1 的移植,wait/no_action 已是一等公民)
- 真正缺的是 Stage-2:回复 LLM 只能输出 1-5 个文本气泡(parser.ts:24-32),贴纸是可被代码忽略的 tag,emoji react 是正则触发(reactions.ts),模型永远不能"就回个 👍"或"只发张贴纸"
- 移植:终写调用换成动作规划:`{action:'reply'|'react'|'sticker'|'silent'|'wait', targetMessageId, text?, emoji?, ...}[]`;react 接 setMessageReaction(替掉正则 reactions.ts),humanizer 效果只跟随 'reply' 动作

**G3【critical/L】无中途打断;在飞回复不可变**(real)
- xxb 源码中所有 AbortSignal 都是网络超时/SSRF 守卫,无一与新消息相连;chat-lock 在 judge+LLM 期间是释放的(pipeline.ts:1149);唯一守卫 shouldSuppressStaleReply 只在"机器人自己中途说过话"时事后丢弃
- 后果:用户补充上下文时,bot 照样回答陈旧状态——最扎眼的"不是人"信号
- 移植:AbortController 贯穿 generateReply + native fetch(signal);进程内 Map<chatId,AbortController>;新消息 → abort → 重排 xxb:pending → 1s 静默期 → 合并重生成;连续打断上限 1

### 🟠 高价值

**G4【high/M】防抖是盲目时间窗,只有最后一条驱动回复**(real)
- 2s 滑窗/8s 硬限(debounce.ts:91-106),flush 后只有 isLastInBatch 跑判断,前面的消息降级为背景(pipeline.ts:1433-1449)。三连发的故事只按最后一句"算了没事"来判断
- 移植:整个 burst 作为判断与生成单元,模型从窗口选锚点;尾句无终止标点→延长窗口("还在打字"启发式)

**G5【high/S】wait 把冲动永久丢弃,从不回来**(real,最高性价比)
- chat-runtime.ts:128-181:resume 只把 WAIT→RUNNING,anchorMessageId 只用来打日志,注释自己都承认是简化。"我等下回"变成永久沉默
- 移植:resume 时带锚点重入回复路径,合并等待期间新消息;若话题已翻篇则重锚定最新(镜像 MaiBot timeout 路径)。锚点已经全程传到了,改动极小

**G6【high/L】回合内无自我接话**(real)
- 发完即止(pipeline.ts:663 一次 generateReply),"多气泡"只是 segmenter 切的;不能发完一句过一拍补"对了…"或跟一张贴纸
- 移植:发完后有限预算(≤2 次)再调动作规划器:"你刚说了 X,还要补充吗?";新用户消息立即终止接话(复用 G3 abort)

**G8【high/L】judge/gate/writer 三个互不相识的 LLM,无人格的沉默**(real)
- 判断(无人格 micro-judge + 60% 骰子)→ 时机门(无人格 gate)→ 写手(只管写)。bot 最像人的杠杆——克制与节奏——全由外部过滤器决定,不反映人格判断
- 移植:L0 正则保留为 0ms 快路;其余合并为一次"社交决策"调用(engage+timing+action 同一 JSON);至少给 gate 喂同一份人格 system prompt

**G9【high/M】状态机是开关,不是注意力梯度**(real)
- RUNNING/WAIT/STOP 纯门控(state-store.ts:27);MaiBot 有 talk_value 折算阈值 + 空闲补偿 + 时段规则的连续渐变
- 移植:`xxb:focus:{chatId}` 0-1 衰减标量(互动升、冷场/无人接茬降);高 focus→降判断门槛/允许接话/缩短防抖,低 focus→倾向 react/沉默。调制而非门控

### 🟡 中等

**G7【medium/M】不会回头翻旧账**(partial —— 管道已齐:#messageId 已渲染、parser 接受任意目标、prompt 已教多目标;缺的是"未回应消息"的扫描与回访)
- 移植:xxb:answered:{chatId} 记录已回应 id,回合开火时浮出 ≤2 条仍相关的未回应消息作候选目标

**G10【medium/M】humanizer 是模型看不见的独立 RNG**(real)
- 每个把戏一颗独立骰子(25% 前缀/10% 错别字/3% 撤回/5% 后补编辑…),时机与内容毫无关联;DM 全部剥除 → 同一人格私聊机器人、群里戏精
- 移植:动作规划输出可带 `{hesitateBefore?, splitAfter?}` 投递意图;每回合"人味预算"(typo/撤回/后补三选一);DM 与群统一进 focus 调制

**G11【medium/L】主动发言是冷启动 cron + 一次性 prompt**(real)
- idle.ts/proactive-scan.ts 用各自的 60-token 临时 prompt 直调 LLM,与主回复管线、与 bot 刚说过的话完全断开 → 永远不会"回到自己刚才的话题"
- 移植:并入回合 actor,proactive 只是带标志的 chat-turn,走同一个 5 层人格 prompt-builder;上一条没人接 + focus 未冷 → 允许回访该线程

**G12【medium/M】同群可双线程并发生成**(real)
- 锁在 judge+LLM 段释放(pipeline.ts:1454 注释明示),两条同群消息可在两个 worker 同时生成,仅靠事后 suppress 兜底 → 偶发自相矛盾的双回复 + 浪费成对 LLM 调用
- 移植:G1 的 turn jobId 唯一性天然解决;不上 G1 则锁贯穿全程,后到者写 xxb:pending 并发 abort 信号给持有者

**G13【medium/S】一锤子生成,无自检重写**(partial —— 发现 expression-selector.ts 是已移植但**未接线的死代码**)
- 现有重试只管格式故障;无反重复守卫 → 经典"bot 复读"无内部否决
- 移植:发送前与最近 1-3 条自己的消息做相似度(无 LLM,Jaccard/ratio),>0.85 带约束重生成一次;顺手把 selectExpressions() 接上线

## 建议实施路径

| 梯队 | 内容 | 改动量 | 效果 |
|---|---|---|---|
| **A 速赢**(不动架构) | G5 wait 回访 + G13 反重复守卫(顺手接线 expression-selector)+ G12 锁贯穿 | S+S+M | 消灭"等了不回""复读""双回复"三个最扎眼的 bot 信号 |
| **B 中改** | G3 打断重规划 + G4 整 burst 判断 + G7 未回应回访 | L+M+M | "你补充我就重想""回答整个念头""会翻旧账" |
| **C 架构改造** | G1 回合 actor → G2 统一动作空间 → G6 自我接话 → G8 合并决策 → G9 focus 梯度 → G10/G11 并入 | XL | 从"会演人的应答机"变成"驻场的人" |

依赖关系:C 内部 G1 是地基;A、B 不依赖 C,且 B 的 abort 通道、pending 缓冲都会被 C 直接复用,不是丢弃式工作。

## 原始材料

- 完整工作流结果:`/tmp/claude-0/-root/0f75a791-0274-4feb-828b-881659d097a7/tasks/wobqarihw.output`
- MaiBot 源码快照:`/root/.tmp-maibot-study`(v1.0-rc.4)、TG 适配器:`/root/.tmp-maibot-tg-adapter`
- 已移植机制清单(不在本差距列表内):ASI 兴趣评分、talk-frequency 自然接话、timing gate(MaiBot Stage-1)、humanizer 自调、主动意愿度等 19 项
