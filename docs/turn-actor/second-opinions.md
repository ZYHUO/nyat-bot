# Turn-Actor 改造:cursor + codex 二次评审要点(2026-06-05)

> 对 `docs/maibot-framework-gap-analysis.md` B+C 梯队设计的外部复核。cursor 负责挖 MaiBot 遗漏机制,codex 负责对照 xxb-ts 实码找实现坑。本文是实施期的工作参考。

## 一、cursor:报告遗漏的 MaiBot 机制(18 项,按重要度精选)

1. **触发数学**(runtime.py):有效频率 = `talk_value × adjust`(上限1);触发阈值 = `max(1, ceil(1/有效频率))` 条未处理消息;**空闲补偿** = `pending + idle_sec/avg_interval ≥ threshold`,avg_interval 取最近 30 分钟外部消息间隔;不足阈值时挂**延迟任务** `delay = (threshold-pending)×avg_interval - idle_sec`,不是直接丢弃
2. **调度去重**:`_message_turn_scheduled` 标志——已排程或 WAIT 时新消息不再入内部队列;`_drain_ready_turn_triggers()` 同 tick 内 message/timeout/proactive OR 合并成一轮
3. **打断细节**:打断后 **1s 静默期**(硬编码);仅 Planner 可打断,Timing Gate 不可打断;打断后**跳过 gate 直接重试 planner**;打断成功**不消耗轮次预算**;**默认 `planner_interrupt_max_consecutive_count=0`(即默认不打断,需显式开)**
4. **Gate 冷却语义与 xxb 相反**:MaiBot `no_action` 后 8s 冷却 = **主动 sleep 拖时间**;xxb `TIMING_GATE_COOLDOWN_SEC=15` = 冷却期 **bypass gate→continue(放行)**。方向反了
5. **Gate 鲁棒性**:非法工具重试 ≤3 次,仍失败 → no_action + enter_stop;gate 子代理丢弃头部 70% 上下文(省 token)
6. **Planner 思考层反重复**(≠回复反重复):planner 自由文本与上轮 difflib >0.9 → 注入"重新思考"提示,同轮继续
7. **轮次预算**:`MAX_INTERNAL_ROUNDS=10`/trigger;tool_continue 递增,打断不递增
8. **锚点规则**:消息批→`cached[-1]`;wait 超时无新消息→`message_cache[-1]`;wait 超时有新消息→注入合成 "wait completed" 消息再 ingest;proactive→合成锚点消息
9. **Replyer Hook 链**:before_request/after_response 钩子,after_response 可置 retry 带"重生成约束"重写 ≤3 次;reply 工具失败**不 pause**,planner 继续下一轮
10. **WAIT 真屏蔽**:WAIT 中普通消息**完全不触发**调度(silent freq 除外);xxb 是 WAIT 下仍 enqueue skipReply job 写上下文
11. **proactive 注入 API**:`enqueue_proactive_task` 写合成任务块进同一 _chat_history → 武装 forced-continue → 可把 WAIT 拉回 RUNNING → 入内部队列;与 reactive 完全同一条 planner/replyer 链
12. **裁切即学习**:上下文裁切时触发 expression/jargon 学习(30s 间隔)+ 可选 mid-term 摘要插入
13. **投递默认值**:中文 0.3s/字、英文 0.15s/字、单字×3、typing_speed 倍率;**仅第 0 段带引用**,后续段只挂 typing(xxb 已大幅压低:0.06s/字、max 1.2s——刻意更快,保留)
14. 其他:vision 占位每轮刷新、person profile 注入 planner(≤4人)、tool_search deferred 可见性、心流实例 LRU(100 活跃/24h 淘汰)、启动恢复 50% 上下文窗口、ReplyEffectTracker

## 二、codex:实现坑(对照实码,13 条)

1. **BullMQ jobId 不能当 turn actor 用**:v5 中同 jobId 已存在时 `add()` 返回旧 job,**不替换 data/delay**;completed/failed 未清理时还会**堵死新 turn**。必须用 `deduplication: {id, replace, keepLastIfActive}` 或显式 `getJob→changeDelay/remove→re-add`;turn job 必须 `removeOnComplete: true`(现 producer.ts:17-20 默认保留 completed!)
2. **actor 模式下 debounce 必须旁路**(debounce.ts:54-163 内存 buffer + flush N job),否则双重合并 + 顺序错乱
3. **direct interaction 路径**(message.ts:79-105 绕过 debounce 即时唤醒)在 actor 模式必须变为"append pending + abort 在飞 + direct 优先标记 + 近即时 turn",不能再走独立 job
4. **WAIT 改造**:WAIT 消息进 pending;resume 调度锚定 `waitAnchorMid` + 期间新消息的 turn(chat-runtime.ts:128-180)
5. **STOP 语义保留**:ingest-only,不调度 turn,direct/proactive 显式 override
6. **shouldSuppressStaleReply 太窄**(pipeline.ts:147-168,只防 assistant 后插;DM/direct 直接 false):需 **turn epoch + high-watermark** 发送前新鲜度检查,旧函数降级为最后兜底
7. **锁竞态有测试固化**:tests/unit/pipeline/pipeline-paths.test.ts:366-389 断言"judge 期间锁已释放"——改锁语义必须同步改测试
8. **AI 调用链无 signal 通路**:ai/types.ts:43-49 无 signal 字段;provider.ts 只有超时 signal;generateReply 无 signal 参数。需贯穿 types→fallback→provider→gate→micro→reply→planner→tools
9. **gate 超时是 Promise.race**(gate.ts:227-244),不真中止底层调用
10. **L0 direct bypass 比报告写的宽**:direct-interaction.ts:67-101、rules.ts:282-394、active follow-up rules.ts:423-448、gate.ts:183-185 —— 都要折成 direct-priority turn
11. **L0 并非真 0ms**:无 replyPath 的 L0 REPLY 会触发 microJudge 补路径(pipeline.ts:1472-1478)
12. **动作空间必须替换而非叠加**:maybeReact 正则 RNG 在 judge 前发火(pipeline.ts:1219-1222、reactions.ts:45-60),action planner 启用时必须关掉
13. **proactive 直发**(proactive-scan.ts:270-286、idle.ts:130-164)绕过全部管线,要转成合成 turn 触发

## 三、共识 rollout(合并两家,env flag 全默认 off)

flags: `TURN_ACTOR_ENABLED` `TURN_ACTOR_CHAT_IDS`(灰度) `TURN_ABORT_ENABLED` `BURST_JUDGE_ENABLED` `WAIT_RESUME_TURN_ENABLED` `UNANSWERED_REVISIT_ENABLED` `ACTION_PLANNER_ENABLED` `SELF_FOLLOWUP_ENABLED` `UNIFIED_DECISION_ENABLED` `FOCUS_ENABLED` `PROACTIVE_TURN_ENABLED` `ANTI_REPEAT_ENABLED`

1. env flags + **abort/signal 通路**(无行为变化)
2. turn 基础设施:Redis pending buffer(含 high-watermark、direct 标志、turn epoch)、abort registry、quiet-period、**安全 turn scheduler**(deduplication API)
3. actor 模式 ingress(flag 下):message.ts → pending + scheduleTurn,旁路 debounce;最小 turn actor 先做"等价旧管线"
4. abort/freshness:新 pending → abort 在飞;发送前 epoch/watermark 校验
5. G4 burst:judge/gate/reply 吃整批,模型选锚
6. WAIT/STOP 对齐(顺手修 G5):WAIT→pending,resume 锚定重入;STOP ingest-only
7. G7 unanswered store + 候选注入
8. G2 action planner(types/parser/executor),react 接管 maybeReact、sticker 一等化、humanizer 只跟 reply 动作
9. G6 自我接话(≤2,新消息即停)
10. G9 focus 标量(吸收 talk_value 触发数学 + 空闲补偿,避免双重调制)
11. G10 delivery hints + G11 proactive 经 actor
12. G8 合并人格决策(最后,校准风险大,需 A/B)
+ 随手:G13 反重复 + 接线 expression-selector(死代码)

**高危测试套件**:pipeline-paths、reply、debounce、chat-runtime、proactive-scan、queue/producer、env(基线 573 全绿,任何红都是回归)

## 四、采纳的 MaiBot 校准值

- 打断连续上限:**可配置,默认 1**(MaiBot 默认 0 太保守,但我们要的就是这个效果;>1 防 thrash)
- 打断后静默:1s(`TURN_INTERRUPT_QUIET_MS=1000`)
- gate 冷却改向:no_action 后冷却期内**不放行**,改为延后调度(对齐 MaiBot 拖时间语义)
- 轮次预算:turn 内部 ≤4(reply 1 + 接话 2 + 余量),MaiBot 是 10,我们保守起步
- 触发阈值:`max(1, ceil(1/focus_talk_value))` + 30min 均值空闲补偿,进 turn-scheduler 的 delay 计算
