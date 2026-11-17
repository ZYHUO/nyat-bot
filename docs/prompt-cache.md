# Prompt cache：计量与前缀

这次修复分别处理实际请求的缓存前缀与用量统计，不启用额外预热、不改变模型路由，也不改变群聊参与、工具授权或记忆可见性。用户报告的 14–40% 尚缺指标来源和线上供应商信息；不能将任何一项代码发现当作这组生产数字的已证实成因。

## 请求内容与缓存边界

- Heart 保留原有判断规则、动态状态、群内经验及输出格式。固定规则置于前部，动态状态置于其后；动态内容仍属于 system，不能覆盖身份、隐私和权限约束。
- ContextEngine 按原有层级及 ID 顺序生成完整 prompt，同时返回本次连续 static 部分的精确前缀。它不复用上一会话的正文，也不假定标为 static 的内容永远不变。
- Meta 和 CodeAct 每次构造请求时传递自己的前缀，包括恢复任务和后续循环。当前任务、记忆、时间和权限信息仍完整保留。
- Claude 格式把第一个 system 分成稳定前缀和动态后缀，只在稳定边界放置 cache_control。拼回文本与原文一致；额外 system 消息也保留。无效边界不会替换正文或借用另一个会话的内容，而是取消本次缓存标记。OpenAI 格式保持原始消息结构。
- SDK 原生工具链保持工具白名单和顺序；没有为了提高缓存比例扩大工具权限或混合会话。

内部日志的旧 cacheHitRatio 已改名为 unchangedContextRatio，表示同一引擎上次组装以来未变化部分的字符比例。它既不是连续公共前缀比例，也不是供应商缓存 token 比例。依赖旧日志字段的监控应切换字段名并更正说明。

## 用量规范化

| 调用格式 | 输入总量 | 缓存读取 | 缺失处理 |
| --- | --- | --- | --- |
| Anthropic Messages | fresh input_tokens + cache_read_input_tokens + cache_creation_input_tokens | cache_read_input_tokens | 任一输入组成未报告时，不将其当作完整缓存比例分母 |
| OpenAI Chat/Responses 形状 | prompt_tokens 或 input_tokens，已包含缓存 | 对应 details.cached_tokens | 不再额外加 cached；缺失、非法或矛盾字段标为未知 |
| DeepSeek OpenAI 格式 | prompt_tokens | prompt_cache_hit_tokens | 同样保留未知与明确零的区别 |
| OpenAI SDK | SDK promptTokens/inputTokens | providerMetadata.openai.cachedPromptTokens，或原始响应中的缓存字段 | 每个完成的工具步骤单独统计，不将多步总输入与末步元数据组合 |
| OpenAI 原始流式 | 终帧 usage | 终帧缓存字段 | 缺失终帧时标为未知；仅官方 OpenAI 端点主动请求 include_usage，其他兼容端点保持请求参数并解析其已返回用量 |

明确返回 0 表示观测到零缓存读取；没有字段表示未知。数值必须是非负安全整数，缓存分量不能超过输入总量。缓存读取和创建是输入的组成部分，不能再加入总 token 数。

Claude 内部截断重试会合并已返回的用量；只有组成请求的数据完整，才进入已知缓存分母。SDK 工具步骤在完成时报告，因此后续工具步骤失败不会抹掉之前已经观测到的用量。

这些统计覆盖调用层返回的结果和已完成的 SDK 工具步骤，仍不是完整供应商账单。失败或中断时供应商未返回的用量、SDK 内部不可见重试、未接入统一事件总线的其他服务都不能凭空补齐。配置 label、model 和 transport path 用于分组，兼容协议名称不保证后端实现相同缓存机制。

## 正确的观察口径

保留原有 llm_tokens_total 总量计数，以免破坏既有成本监控。新增指标按 usage、label、model、path 分组：

- llm_cache_observations_total：known、input_unknown、cache_unknown 的结果数量。
- llm_cache_tokens_total：observed_input、covered_input、read、write 的 token 总量。
- llm_cache_write_observations_total：写入用量的 known/unknown 覆盖情况。

同一时间窗口、相同分组的输入缓存比例为：

```text
sum(read) / sum(covered_input)
```

不能除以含输出的 total，不能把未知视作 miss，也不能简单平均各请求百分比。分母为零时没有可报告比例。应同时展示结果覆盖率及输入覆盖情况，避免少数可观测请求被误当成全部流量。

日报会提供 prompt、coveredInputTokens、cacheReadTokens、cacheHitRatio 和覆盖信息，详细记录可按 byRoute 查看。历史账本没有覆盖字段，因此旧 cached 不混入新比例的分子；历史数据未被回填或改写。模型或路径未知的记录保留为 unknown，不能伪装成另一供应商的数据。

指标不包含提示词、工具参数、返回正文、密钥或服务地址。日志不再只将大输入低命中的请求提升到 INFO；应使用完整计数器或同窗口账本，而不是从日志样本估算全量命中率。

## 验证和线上限制

离线测试使用合成提示词和用量，覆盖多供应商分母、明确零与缺失字段、流式终帧、逐步 SDK 计量、重试、动态后缀、多个 system、无效边界及跨会话隔离。组合测试贯通 ContextEngine、fallback、请求序列化与事件总线；它们不证明真实供应商会命中缓存。

部署后的验证应先确认实际版本、路由和指标来源，再在同窗口比较新指标与供应商用量；本轮没有部署或进行真实模型调用。若以后做受控对照，先使用合成内容固定模型、权限范围、工具集合和请求参数，每次只改变一个因素，并同时观察延迟和行为回归。不要为了缓存删除时间/记忆、扩大权限、延长过期状态或增加无预算预热。

协议依据：[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[DeepSeek context caching](https://api-docs.deepseek.com/guides/kv_cache/)。缓存门槛、有效期和路由机制随供应商及模型而异，代码没有据此承诺固定命中率。
