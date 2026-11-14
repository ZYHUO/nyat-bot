# 有界的数字短诗项目

这是一个实际保存文件的数字创作项目，不是生成“上学、吃饭、见朋友”的实体生活经历。现阶段只支持四行中文短诗，文件验收只证明格式、内容和哈希一致，不证明文学水平提高。底层复用认知账本、mission/wake、现有 CodeAct 进程隔离和 task acceptance；不启用所有旧 mission 候选。

## 激活与执行

`LIFE_PROJECT_ENABLED` 默认 false。还必须由操作者在本地显式激活一个项目，绑定当时的机器人账号与已配置主人的私聊。群、陌生私聊和无来源旧项目均不接受。激活记录是 host 的 operator 配置事实，不伪造 Telegram/QQ 用户消息，也不把操作者的要求说成机器人此前已有的愿望。

2026-11-15 的生产版本 8481c79 已开启所需开关，并由 host 显式激活一个绑定当前账号及主人私聊的短诗项目。北京时间 11 月 15 日 02:52 的只读核验确认：生产首次 attempt 已 succeeded，历时 4 秒，实际模型请求 1 次，记录的作品为 88 字节，结果为 artifact_verified。项目仍 active，已消耗 1/8 次尝试额度，下次练习安排在本次完成后 24 小时。激活和背景练习均没有平台发送。

后续 6144083 已发布调度修复：interval 依据真实完成时间推进，专用生活项目协调器不再与通用 mission_due 重复安排。05:00 定时备份恢复后的只读观察已看到同一进程四次成功 tick，间隔符合配置、无失败或 unknown；项目仍为 1/8、仅一次模型请求，两个旧 wake 已 checkpoint，唯一待执行 wake 与项目 next_due_at 相同。此次核验未改数据库、未重新激活项目、未额外调用模型或发送消息。

运行 [scripts/life-project.mts](../scripts/life-project.mts) 的 `activate` 动作时提供一个私有 JSON 文件，包含 `chatId`、`objective`、`operatorRef`，可选 `maxAttempts`（1 至 8）。示意字段：目标是“练习四行中文短诗，保留真实数字作品与失败”，operatorRef 使用本次发布操作编号。脚本只保存激活事实和下一次 wake，不启动平台、不调用模型、不发送消息。`cancel` 动作接受项目 ID 和原主人私聊 ID；不能取消其他账号或其他会话的项目。

运行端需要 `COGNITIVE_CONTINUITY_ENABLED`、`COGNITIVE_PROCESS_RUNTIME_ENABLED`、认知事件存储以及实际可用的 CodeAct OS 隔离。项目由既有 cognitive continuity tick 推进。每次开始前在 SQLite 事务中领取唯一 attempt，父项目同一时间只能有一次 running attempt。每天最多开始一次，总计最多八次，一个月期限；失败也消耗尝试额度。

每次练习最多 45 秒、两个真实模型网络请求、每请求最多 1200 输出 token。计费前必须完成持久 CAS；超时或未知结果不返还预算。严格模型模式禁止 hedge、SDK 隐式重试、Claude 空推理二跳与自动提额。隔离 guest 只有 `creation.writePoem`、`runtime.verifyAcceptance`、`runtime.endTask` 三个能力，没有平台发送、网络、任意路径或通用 host API。

## 作品与失败

作品放在 `LIFE_PROJECT_ARTIFACT_DIR` 指定的私有根目录，默认在业务 data 内；若改为其他位置，必须同步纳入备份。每次 attempt 只允许一个不可覆盖的版本，最多 4KiB。host 生成文件名，独占创建、fsync，并保存实际字节数、SHA256 和来源事件。验收拒绝路径跳转、符号链接、硬链接、超限内容及文件变化；读侧再次校验哈希。

进程在已开始后退出，过期 attempt 会成为 unknown，项目 held，禁止自动重跑。已完成文件和失败记录保留；不能把 unknown、无文件、模型自行声称完成变成成功。取消后的重启不继续执行。换账号后旧记录保留在旧来源，不迁移或重标。持久性依赖当前单 SQLite state service；这不等于已支持跨机共享 SQLite 或数据库灾难恢复。

真实 Meta workspace 仅在该账号的主人私聊中读入最新项目结果和两次练习的作品。普通群、陌生私聊及其他 bot 账号不获得这段私密项目上下文。背景练习始终零外发；用户主动问起时，普通聊天可以根据本会话可见的实际记录回答。

## 验证边界

[tests/unit/agent/life-project.test.ts](../tests/unit/agent/life-project.test.ts) 用真实文件 SQLite 每日关闭重开，重放 30 天；使用真实文件和验收器、mission/wake/runtime/workspace 链，模型和 OS guest 为受控替身。它覆盖预算耗尽、失败保留、并发领取、崩溃未知、取消、账号切换、来源隔离及文件篡改。OS guest 隔离与严格模型网络请求另有独立集成证据。

2026-11-15 另完成一次隔离 Linux 集成样本：以实际服务用户运行真实 CodeAct OS guest，使用合成主人身份、全新 SQLite 和独立 Redis，调用已配置模型 1 次，HTTP 200，实际请求上限为 1200 输出 token。6.8 秒内保存并核验一份 127 字节的四行作品，主人上下文可读取，群与陌生私聊不可读取；没有平台发送，也没有伪造用户事件。该样本没有激活生产项目，没有访问生产数据库，不代表真实用户已收到作品、生产持续运行或文学质量已改善。

离线重放证明受控时钟下的可恢复机制；单次真实隔离样本证明该执行链可以生成并核验文件；生产首次成功则证明实际运行链已保存并验收一次产物。三者不能合并称作已经在线生活 30 天，也不代表长期人格已经完成。现有定性样本仍有嘴硬和表达质量波动，作品质量需要独立评审。此版本没有假定朋友的评价或沉默代表作品进步，也没有自动把每次练习升格为已验证自我信念。
