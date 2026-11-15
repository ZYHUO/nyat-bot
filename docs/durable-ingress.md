# 消息持久接管与编辑版本

`DURABLE_INGRESS_ENABLED` 默认关闭。开启前应用迁移 0125，启用时 TG 在 allowlist 后、命令和消息处理器前保存输入；QQ 在账号、allowlist 和激活时间验证后保存原始规范化消息。未授权会话正文不会因这个功能而被采集。记录包含平台、当前已验证账号、会话类型、原消息 ID、编辑版本和完整正文；不要将数据库或备份当作可公开的日志。

SQLite 接管和首次 claim 使用 FULL 同步事务。接管成功后才允许执行 handler。重复输入不能覆盖首次接受的原文；同一消息的编辑是独立版本，不是覆盖重复标记。

## 状态含义

| 状态 | 可自动重放 | 含义 |
|---|---|---|
| pending | 是，重新验证账号及权限 | 已保存正文，handler 从未开始 |
| processing | 否 | 已领取、租约未过期，可能正在产生副作用 |
| handler_returned | 否 | 入口 handler 已返回；不代表异步推理、任务或发送已经完成 |
| settled | 否 | QQ 批次的本次判断及 Attention 接管已返回，或候选已撤回/回答；不等于已发送 |
| unknown | 否 | 已开始但失败、退出或租约过期，效果可能已经发生，先核查 |
| held | 否 | 当前账号、会话授权或来源已不匹配 |

只有 pending 会自动恢复。恢复查询按 SQLite sequence 分页，没有 500 条总量截断。每个页次和并发量有上限；满容量的 QQ 候选留在数据库等待以后加载。旧的 Redis 去重记录不删除；历史未持久化的输入不能凭推测补回。unknown/held 不自动清理或发送；迁移没有将旧状态伪装成新的、已验证输入。

## QQ 合并窗口

每条消息仍先进入真实会话上下文，携带真实消息引用；1500 ms 静默、4000 ms 最大窗口的行为保留。候选先写 SQLite，再启动定时器。重启只恢复尚未开始的候选，复用 Heart → Attention 判断，不重放命令、媒体转换或入口统计。

启动判断前 claim、复查当前账号/allowlist、撤回和已回答状态；引用片段若已撤回则移除。运行中租约续期，取消后不把结果记为 settled。Attention 的严格模式会检查 Redis 事务结果，不能把内存兜底冒充持久接管。停止时先停止恢复派发，abort 在途批次并 join；未开始的候选仍保存在数据库。

这不是全链路 exactly-once：Heart 可能产生表情或等待状态，任务及发送还有独立回执；在途崩溃不会自动尝试判断第二遍。TG 的既有异步 Heart/媒体路径也不是由 inbox 单独证明完成。handler 返回和实际外发确认必须分别检查。

## 平台确认边界

Webhook 在 SQLite 接管失败时返回 503。已经接管、但 handler 失败的输入会持有 unknown 状态并返回正常 ACK，避免平台无限重投同一个可能已执行的请求。

grammY 长轮询在调用 handler 前就推进进程内 lastTriedUpdateId。接管失败必须立即退出进程，不调用 bot.stop，也不在同一个 Bot 上重开轮询，否则后续 getUpdates 会确认丢失的输入。正常新进程从未确认的 update 重新读取；相关测试使用真实 grammY polling loop 和本地 API stub 验证没有下一次更大 offset 请求。

OneBot 正向 WebSocket 没有应用层逐消息持久 ACK。SQLite 不可写时停止该消息处理并记录固定诊断码；不能声称此前已从网络收到的帧一定会由客户端再次投递。持续存储故障必须告警，不能以 ready 连接状态替代持久接受证明。

## 身份与时间

新 `MessageEventIdentity` 将消息主体身份和版本拆开：平台、账号、namespace、会话类型、thread、原消息 ID 共同确定主体；编辑版本还包含 edit_date、update_id 和规范化内容摘要，因此同一秒内两次编辑不再共用 BullMQ job ID。

四个时间字段全部为 UTC epoch 毫秒：occurredAt 是原始发送时刻，editedAt 是平台编辑时刻，receivedAt 是本次首次持久接收时刻，processedAt 是首次开始处理时刻。平台未给的时间为 null，不能用接收时间冒充。旧 FormattedMessage.timestamp 保留秒单位及历史显示语义；消费者应明确选择所需时间，不以旧消息补投的接收时刻推断用户正在连发。

完整正文另外交给 memory source/projection outbox，使用同一个 eventId/revision。入口 claim 与 memory source 不是同一事务：两者之间崩溃会留下可检查的 unknown 原始输入，不会假称记忆已经落库。AI 媒体描述属于衍生信息，不能改写已接受的原文。

记录当前没有自动保留期删除。备份必须覆盖此表，备份恢复默认禁止平台收发；unknown 必须先核对外部回执再人工处理，不能将备份中所有输入重新派发。
