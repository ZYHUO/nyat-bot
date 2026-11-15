# 单一状态 authority 的 A/B 发布闭环

这是默认关闭、尚未部署的运维入口。它让主人通过私聊命令请求切换到**运维已构建、封存并批准**的固定提交，或回退到上一健康版本。候选版本健康失败会自动回退。控制器不运行在 bot 内部，不下载任意 URL，不执行模型给出的命令，不让模型读写环境文件，也不删除旧版本或用户状态。

当前多机边界仍见[部署拓扑](../../docs/deployment-topology.md)：单一 authority 拥有 SQLite、NyatDB、Redis 业务状态与发送结算；embedding、视频与 QQ 客户端保持独立。此方案仅接管一个 authority systemd unit，不能作为跨机 HA、双活写者、数据库切主或无停机更新使用。

## 实际切换顺序

1. 外部进程取得与备份控制器**相同的独占 flock**；检查固定分支、完整提交 ID、批准列表、所有文件摘要、只读权限、迁移摘要和状态兼容契约。
2. 请求回环的 `/ready`，核对实际 systemd MainPID、启动时刻与当前提交。普通 `/health` 只代表存活，不能批准切换。
3. fsync 写入恢复日志后停止旧 unit。要求 MainPID 为零、整个 cgroup 及子 cgroup 无进程；旧进程还必须正常退出并提供同一 PID/启动时刻的干净关闭 checkpoint。checkpoint 只有在入口、生成任务、worker、SQLite、NyatDB、Redis 全部完成收尾后才产生。
4. 原子替换 current 链接，启动候选版本。等待真实依赖及入口就绪，再持续观察；PID 重启、错误提交、非 200、依赖失败都视为失败。
5. 成功后持久化新版本和上一健康版本。失败则先停止候选并证明 cgroup 已空，再恢复原版本并重新健康观察。如果不能证明进程已停、恢复失败或摘要发生变化，保留恢复日志并明确失败，不启动第二个写者。

停机期间已经接收的 CodeAct 入队失败，或本地 fallback 的任务领取、执行、解锁发生未结算错误时，不会生成干净关闭 checkpoint；控制器拒绝启动候选。仅已确认写入隔离归档的策略拒绝不算丢失工作。本地 pending 也必须先得到持久队列回执或完成执行才能交接；忙碌会话的领取会退避，停机后不再重试。失败日志中的任务需要人工核对原任务记录与投递结算，此处不会自动重放发送结果未知的任务，也不声称本地内存队列具备断电恢复能力。

运行中断后，下一次控制器调用先恢复未完成切换。独立 boot recovery unit 在 bot 启动前恢复未提交的版本选择；它只允许对已停止的 unit 操作，不递归启动 bot。已提交但尚未清理日志的切换按已提交决定完成。恢复控制器、启动器和配置均安装在 releases 之外，候选代码失败不会删除恢复入口。

## 状态、秘密和兼容性

发布目录内禁止运行时 data、var、logs、Git 元数据和真实环境文件；仅允许仓库根目录公开的环境示例。内部依赖链接必须留在同一发布目录。所有文件归 root 所有并封为只读，摘要覆盖文件内容和链接目标。build provenance 记录完整 SHA 与固定分支。摘要是完整性检查，不是构建供应链签名；构建用户、代码审阅与批准仍是信任边界。

进程使用稳定的 runtime 工作目录，所以现有相对 data、var、logs、skills、prompts 仍指向同一份状态。runtime 目录本身由 root 持有、bot 不可写；只将这些明确的业务子目录授予 bot。runtime/migrations 必须是指向 releases/current/migrations 的只读链接，启动器逐次检查它。其他已有静态资源或脚本依赖由运维盘点后用固定 current 链接接入；不要复制一份新的空 data 当作配置交接。原有可变 prompts 保留，自主改提示词不会改动发布载荷。源码版本内的 prompts/skills 变更不会自动覆盖这些可变目录；运维必须单独审阅并迁移，state-contract 也必须覆盖代码对它们的兼容要求。回退同样不会倒退这些业务状态。

平台令牌、提供商密钥与其他环境值继续放在外部、root 所有、0600 的 systemd EnvironmentFile；runtime 下不能放本地环境文件。Redis runtime config 和受限业务配置留在原 authority，版本切换不会覆盖它们。配置改变不等于授权跨会话披露。构建用户不能访问这个环境文件、runtime 状态或发布控制目录。

自动切换要求 SQL 迁移、SQLite/NyatDB 存储代码摘要完全相同，还要求运维为两个版本声明相同的 state-contract。该契约必须审阅 Redis 数据、队列 job、发送结算、业务配置、跨服务协议及所有非 SQL 数据格式；相同迁移文件不能证明这些都兼容。含新迁移或契约变化的版本**没有强制绕过参数**，必须走单独的人工升级与兼容验证。第一次采用此方案也需要人工部署具备 `/ready` 的基线，旧版普通健康接口不能伪装通过。

回滚从不恢复旧数据库快照、不删除新产生的数据，也不重置发送结算。候选版本已对外发送的消息无法撤销。已有 delivery ledger 的未知投递保持未知，不能因为版本回退就自动当作未发送重投。此处保证不会同时运行两个受管写者，**不承诺端到端 exactly-once**。systemd 外的手工进程、另一个 unit 或另一台 authority 不在这个锁的保护范围内，首次采用前必须关闭这些重复写者。

## 运维采用步骤

模板见[控制器配置](config.example.json)、[authority unit](nyatbot.service)、[请求处理 unit](nyatbot-release-control.service)、[timer](nyatbot-release-control.timer) 和[启动恢复 unit](nyatbot-release-recovery.service)。示例不是已安装服务，所有路径、用户名、Node 22 路径和 request_uid 都必须按机器实际情况核对。

1. 先停用旧的原目录更新 timer，盘点所有状态写者和角色。旧[更新入口](../../scripts/auto-update.sh)已经改为只调用独立控制器；未安装时失败退出。不要把新旧更新机制并行启用。
2. 使用专用、非 root、不能读取运行时秘密和状态的构建账号运行[固定提交构建脚本](../../scripts/prepare-release.sh)。脚本只从 ZYHUO/nyat-bot 的 codex/onebot-qq 获取源码，验证指定提交属于该分支，使用全新 HOME 和清空的环境运行 npm ci、typecheck、lint、tests 与 build。只接受完整的 40 位 SHA，不接受 latest、任意远端或 main。网络拉取和 npm 生命周期脚本只在该低权限账号运行。生产启用 native NyatDB 时，必须在相同隔离构建环境完成对应 native 构建和 ABI 验证；不要用缺失 native 的 fallback 冒充同一引擎。
3. 运维审阅构建结果、兼容契约与固定提交；将完整输出复制到 root 所有的 releases/SHA 目录，保留内部相对链接。不要从生产工作目录复制秘密、data 或日志。将[控制器](../../scripts/release-controller.py)和[启动器](../../scripts/release-launcher.py)单独安装到 root 控制目录，不授予 bot 修改权限。
4. 创建配置中列出的目录。release_root、result_dir 为 root 所有 0755，control_dir 为 root 所有 0700；request_dir 为 bot 所有 0700，父目录 root 所有且不可由 bot 写入。请求目录与 control_dir 必须在同一文件系统，原子移动跨设备不受支持。配置为 root 所有 0600，父目录不可由非 root 修改。将启用项改为 true 并填入准确批准 SHA 后，人工运行 seal 和显式 state-contract；此时尚不启用 timer。
5. 将原有状态迁至或接入稳定 runtime 目录，确认默认相对路径和所有显式绝对路径都指向原数据；保留可写 prompts/skills。建立上述 migrations 链接和所需静态资源链接。把旧环境值放入外部 EnvironmentFile。备份控制器也必须改用同一个 lock_file，否则备份恢复可能在交接中意外重启 bot。
6. 首次基线由运维在维护窗口建立 current 链接并安装服务；验证真实 `/ready`、正常关闭 checkpoint、cgroup 清空、启动恢复依赖及原数据可用性。模板的 ProtectHome/ProtectSystem/ReadWritePaths 需要与已有视频/沙箱/NyatDB 路径核对，不能直接覆盖已运行的 unit。
7. 用两个兼容的、批准且封存的测试发布演练成功切换、健康失败、强制终止控制器、断电后恢复和回退。确认后才启用请求 timer 和 bot 的受限开关。两版都保留；此控制器没有自动清理命令。恢复日志、审计和请求回执也不自动删除。

以下是接口形式，所有示例 SHA 与路径都必须替换；这里的命令未在生产执行：

```bash
# Dedicated non-root build account, verified Node 22 on PATH:
bash scripts/prepare-release.sh "$FULL_SHA" "$NEW_BUILD_DIRECTORY"

# Operator, after copying the build to the configured releases/FULL_SHA:
python3 /opt/nyatbot-release-control/release-controller.py --config /etc/nyatbot-release-control/config.json seal "$FULL_SHA" --state-contract state-v1
python3 /opt/nyatbot-release-control/release-controller.py --config /etc/nyatbot-release-control/config.json activate "$FULL_SHA"
python3 /opt/nyatbot-release-control/release-controller.py --config /etc/nyatbot-release-control/config.json rollback
python3 /opt/nyatbot-release-control/release-controller.py --config /etc/nyatbot-release-control/config.json status
python3 /opt/nyatbot-release-control/release-controller.py --config /etc/nyatbot-release-control/config.json recover
```

若错误为 controller_recovery_required，保持所有版本和日志，检查受管 unit 的 PID/cgroup、外部写者、磁盘和原版本依赖；恢复条件确认后用 recover 重试，不手动改日志把失败标为成功。自动激活不会刷新 root 批准列表，也不会代替这个人工恢复判断。

## 主人指令与请求协议

bot 开关 `UPDATE_REQUESTS_ENABLED` 默认 false；还必须配置 `UPDATE_CONTROL_CHAT_IDS` 为主人的私聊内部 ID 灰名单，并设置 `UPDATE_REQUEST_DIR`、`UPDATE_RESULT_DIR`。QQ 使用映射后的内部会话 ID，不是原始 QQ 号码。配置的请求目录必须是 bot 所有 0700，结果目录必须 root 所有 0755、回执 root 所有 0644，路径不允许符号链接别名。

精确命令为 `/update activate <完整提交SHA>`、`/update rollback`、`/update status <32位请求ID>`。入口只接受五分钟内新鲜的主人原始私聊消息，拒绝转发、编辑、机器人和 business 消息。它用消息来源计算稳定请求 ID，以排他原子发布提交固定字段；排队成功与更新成功分别报告。没有回执表示尚在排队或结果未知，不能当作成功。

控制器固定接收一个 request.json，最多 4096 字节，要求指定 bot UID、普通文件、无链接跟随、精确字段集合，只允许 activate 和 rollback。它把请求原子移到 root 私有目录，解析一次后持久化固定目标；rollback 重试不会反向翻回。已存在回执的请求 ID 不再执行。任何任意 shell、URL、路径、参数或未知字段都被拒绝。

安全回执包含 version、id、status、activeRelease 和 error，error 成功为 null、失败为固定错误码，不包含命令输出、秘密、用户消息或日志正文。保持回执是去重契约的一部分。请求队列不是人工审批通道；安全边界在 root 配置的批准列表、不可变发布和主人私聊授权。

## 验证范围与下一阶段

离线测试入口：

```bash
python3 -m unittest discover -s tests/ops -p 'test_release_controller.py' -v
bash -n scripts/prepare-release.sh scripts/auto-update.sh
python3 -m py_compile scripts/release-controller.py scripts/release-launcher.py
```

测试使用真实临时文件、文件权限、flock、原子链接、SIGKILL 子进程与回环 HTTP；systemd 动作使用会跟踪活动写者的状态模型，cgroup 读取用真实临时层级。它覆盖正常切换、错误候选恢复、恢复失败保留日志、旧 checkpoint 不匹配、残留子进程、摘要/迁移/契约不兼容、请求重复、符号链接和超大输入。这不是生产 systemd、平台投递、主机断电或多机故障切换的实测证明。类型检查、lint、bot 客户端与 readiness 测试由仓库常规验证执行。

下一阶段应先在隔离机器用实际 unit 做上面的故障演练，再考虑签名构建产物、自动下载审批策略、更多状态格式兼容证明、全域外发 fencing 和多机 state authority 接管。计算服务副本继续独立部署，不随这个 bot 版本指针自动切换。
