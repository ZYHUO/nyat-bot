# 离线报告与 CI

日志工具仍默认读取运维工作目录下的 app 日志。CI 使用明确编写的合成 JSONL、独立临时目录与固定观察时间，不复制生产聊天、凭据或私密环境文件。测试会拒绝子进程发起 fetch；报告中的数字只说明样本，不是生产健康证明。

[log-count](../scripts/log-count.mts)、[coherence-probe](../scripts/coherence-probe.mts)、[measure-voice](../scripts/measure-voice.mts) 和 [session-report](../scripts/session-report.mts) 都支持 `--log-file PATH` 与 `--now ISO_TIMESTAMP`。原有位置参数保持兼容。观察窗口不包含观察时间之后的日志；`--day` 仅选择指定 UTC 日期。

session-report 离线回放必须带 `--offline`，这样不会读取默认业务 SQLite，也不会连接实时 metrics。可额外传 `--db-file PATH` 读取只读数据库快照，或传 `--metrics-file PATH` 读取 Prometheus 文本快照；省略的来源明确标为未读到。离线报告不加载私密环境文件、不运行迁移、不发送平台消息。

示例命令（将大写占位符替换为自己的文件）：

```sh
node --import tsx scripts/session-report.mts 3 --offline --log-file INPUT_JSONL --metrics-file METRICS_TEXT --now 2026-11-15T12:00:00Z
node --import tsx scripts/measure-voice.mts --log-file INPUT_JSONL --day 2026-11-14 --now 2026-11-15T12:00:00Z
```

[日志行为测试](../tests/unit/scripts/session-report-runs.test.ts) 断言实际计数，包括编辑入站、打断类型、四态分母、失败 pass 和任务开口次数。[话题重放测试](../tests/unit/subagent/topic-repeat-production-replay.test.ts) 用合成同群序列调用真实重复闸，验证窗口和停用词差异；文件名沿用旧名，但测试不再声称它是生产样本。线上回放仍可显式提供经授权的本地日志，再按其真实分母解释结果。
