# 一致性备份与隔离恢复

控制器位于 [scripts/backup-controller.py](../scripts/backup-controller.py)，配置模板位于 [ops/backup-config.example.json](../ops/backup-config.example.json)。需要 Python 3.12 及 root 身份；安装服务前必须核对实际写入进程、存储路径和已验证发布版本。模板中的占位值会使预检失败。

## 安装前核对

- 配置文件、rclone 加密配置及其密码文件由 root 持有，权限 0600。密码文件通过 `drive.config_password_file` 指定，仅送入 rclone 子进程的 `RCLONE_CONFIG_PASS`，不放在命令参数、报告或日志里。
- `shutdown_journal` 位于持久的 root 0700 目录。systemd 单元用 `ExecStartPre` 的 install 命令创建该目录，兼容 systemd 219；手工调用前需先创建。journal 自身权限 0600，不含消息正文或凭据。
- `quarantine_root` 必须是预先创建的 root 0700 目录，与项目、备份、SQLite 所在目录及所有归档源完全分离。恢复目标只能是它尚不存在的直接子目录。
- `writers` 必须覆盖全部 SQLite、NyatDB 和业务 Redis 的写入进程。每个进程都必须产生与刚停止的 PID 和本次请求时间绑定的 clean shutdown proof；仅退出成功不足以证明完成了所有异步写入。
- Redis 必须是业务专用实例。Qdrant 自身服务可继续运行，但其在线存储目录必须从普通文件归档排除；控制器逐 collection 创建并下载原生快照。
- `release` 必须填已核验的完整 Git SHA。`embedding` 填实际模型、维度、collection；命名向量还需 `vector_name`。控制器校验格式及快照内 collection 的向量维度，不能仅凭维度证明模型语义或发布内容相同，运行值仍须由操作者核验。
- 归档源必须实际存在；不要为不存在的目录保留示例项。部署与备份共用同一把独占锁。

## 停机与中断恢复

控制器在停止每个原本健康的服务之前，先原子写入并 fsync 恢复 journal。正常返回、快照失败、SIGTERM 或 SIGINT 都会进入恢复流程，按反序启动已记录服务。每个服务确认 active 且有主进程后才从 journal 移除；失败项保留以便重试。恢复期间忽略重复 TERM/INT。

SIGKILL 无法执行 Python finally，因此单元另有 `ExecStopPost` 调用 `recover-writers`。它只依赖私有配置、journal 和部署锁，不依赖损坏的数据目录、模型或远端备份。机器断电时不能当场恢复；下一次 capture 会先处理遗留 journal，也可显式运行 `recover-writers`。不要删除未完成的 journal 或擅自移除其中单元的配置。恢复失败会使命令失败并保留记录，不会声称服务已恢复。

## 各阶段证据的含义

定时器每小时唤起 `capture-if-due`，不依赖宿主时区，也不使用旧 systemd 无法解析的 UTC 日历后缀。控制器按固定 UTC+8 的 04:00 分隔 24 小时逻辑日：当天成功后只返回 skipped，失败或中断不推进成功日，下一小时可重试。跨年与宿主夏令时不改变日界。错过执行会补当前应备份日，不为每个历史空缺连续生成快照。手工 `capture` 仍可强制执行。

`schedule_receipt` 是另一个 root 私有 JSON，与停机 journal 分开；独立调度锁覆盖一次检查、快照和上传。若上传已完成但进程在写调度回执前退出，可以从本地 version 2 的 `COMPLETE.json` 及对应 manifest 哈希恢复成功日。旧版或仅 pending 的回执不用于跳过备份，未来时间或缺少时区的记录也不能抑制当前备份。

`verify` 校验所有列出的文件哈希、SQLite 完整性、每个 Qdrant collection 对应的非空快照、模型 collection 与维度。Qdrant HTTP 重定向始终拒绝，包括同主机重定向；API key 不会跟随跳转。

`capture` 在停止全部业务写入方后复制 SQLite、Redis、Qdrant 快照及未压缩 tar；服务恢复成功并释放部署锁后，只压缩已冻结的 tar，再计算哈希和加密上传，不再读取活动目录。这样缩短了压缩造成的停机，但临时磁盘需要容纳未压缩 tar 及正在生成的 gzip；空间不足仍会失败，不牺牲一致性。上传必须通过 `cryptcheck`、远端 manifest 回读和完成回执回读。本地先写 `COMPLETE.pending.json`，远端回读成功后才原子变成 version 2 的 `COMPLETE.json`；中途退出不会产生可跳过下一次备份的本地完成标记。完成回执只表示本代上传已核验，其 `restored` 仍为 false。

manifest 还从本次 SQLite 快照记录权威输入、认知事件、记忆正文版本和投影 outbox 的水位：行数、摘要哈希、入站最大 sequence、状态分布、投影最后完成 ID 与最早未终结 ID，以及当前模型/collection 对应的缺失或未完成版本数。认知事件的 sequence 是每 correlation 内顺序，不冒充全局日志位置；done 的最大 ID 也不冒充所有先前任务完成。不存在的表明确标 absent，未知入站仍是 unknown。水位不包含聊天正文，恢复验证会从 SQLite 重新计算比对；这仍是账本状态，不代替远端向量内容核验。

## 已验证快照保留

模板启用 `retention`：14 个 UTC+8 04:00 逻辑日、8 个 ISO 周、12 个自然月，每个周期保留最新成功快照，取三组并集；本次成功代和最新成功代始终保留。旧配置缺少 retention 时默认不清理，需显式加入模板中的完整配置。

清理仅发生在本次 capture 的上传、cryptcheck、manifest 与 COMPLETE 回读全部通过之后，且只涉及专用 crypt prefix 内的本工具代目录。每个候选要求本控制器 producer、水位版本、完整文件目录清单、manifest 哈希绑定的 version 2 COMPLETE 和合理时间；无完成标记、旧版缺来源、哈希不符、额外文件或未知目录全部保留。删除前复读双证据与文件清单，变化或读取失败就中止。

控制器不执行递归 purge：先精确删除过期代 COMPLETE，再删除清单内每个文件，最后尝试删除空目录。失败后不会继续删其他代，也不会误把残留半代当成功备份。本次已验证备份仍保留；清理错误需单独查看，不能反过来声称备份内容无效。所有清理回执写入 staging 根目录的独立 retention JSON，不混入已封存快照。此策略不删除本地快照、不清理未知/失败代，也不支持其他进程并发改写已封存远端代；这些由操作者单独处理。

`restore-quarantine` 必须提供配置与新隔离目录。它不启动服务、不加载队列、不使用恢复出的凭据，也不发送平台消息。`RESTORE_QUARANTINED.json` 仅表示文件已隔离解包、SQLite 已验证；Redis 隔离加载、Qdrant 实际恢复、NyatDB 打开及带来源查询、未知发送状态核对仍需单独完成。没有这些证据就不能宣称已通过完整灾难恢复验收。

## 本地回归

运行 `python -m unittest discover -s tests/ops`。测试使用真实临时 SQLite、真实本地 HTTP 重定向和硬退出子进程，systemctl/rclone 外部动作替身及合成数据；它不等同于真实 systemd 恢复或云端灾难恢复演练。
