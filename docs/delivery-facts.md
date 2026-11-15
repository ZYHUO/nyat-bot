# 投递事实与未确认结果

发送实现见 [发送器](../src/bot/sender/telegram.ts)、[结果契约](../src/shared/delivery-result.ts) 与 [legacy 结算](../src/pipeline/stages/deliver.ts)。

`sendMessageDetailed` 返回 `sent / suppressed / failed / unknown`，包含 intentId、revision、目标、计划片数，以及逐片真实平台 ACK 的 ID 和正文。`failed / unknown` 也可能包含此前成功的片段；这些片段可以进入历史，但不能把剩余计划正文写成已经说过。`sent` 表示本次全部片段确认，不能推断用户已阅读。

旧 `sendMessage` 成功继续返回正整数 ID；其他情况抛出携带结果的 `DeliveryError`，不再用负数代替消息 ID。旧 `StreamingSender.sendDirect` 成功返回 ID 和实际 parts；失败同样抛结构化错误。流式编辑仅报告最后确认的正文，模型生成缓冲区不是已发布事实。原先四字符前缀抑制策略仍保留；抑制明确属于未发送。

legacy 按成功片段保存助手历史，按完整逻辑回复的目标清偿 answered 和 obligation。A 成功、B 失败只清偿 A；不会因为 A 成功就自动把触发者 B 标为已回答。语音使用实际回执 ID，修正编辑仅在确认后更新记录。未知发送立即停止本批后续目标，不补发同一文本或故障兜底。

CodeAct 的 TG 与 QQ 任务都在外发前向 Redis 写唯一 attempt 的 intent。写失败不发送；明确未发送或平台拒绝可用 compare-delete 清除自己的占位；确认成功同样只清自己的占位。未知、进程崩溃或确认账本不可写时保留 hold；当前任务停止，旧队列 payload 重放也被拒绝。hold 不含消息正文，且没有自动到期。运维解除前必须核对平台是否实际收到，不能靠重启清除。

这仍不是所有路径的通用 outbox，也不承诺 exactly-once：legacy、独立 cron、直接平台 API 尚未统一持久投递账本；确认后、历史/任务状态落库前仍需要后续恢复协议。Telegram 没有通用发送幂等键，网络超时不能证明未送达。跨机 gateway/leader fencing 和持久回执补偿属于后续批次；不能因新增结果类型而宣称已经实现高可用。

测试入口：发送器与流式故障、实际 pipeline 多目标结算、真实 host→executor 未知投递关闭和重放拒绝。测试使用合成身份与替身平台，不外发真实消息。
