# 从云端恢复的隔离演练

此工具验证一个已经封存并上传的备份代能否从配置的 rclone crypt 云端重新下载、解包和打开。它不会启动 NyatBot、队列、cron、QQ 或 Telegram，也不会加载恢复出的 .env。成功回执不代表生产已切换到恢复数据，更不代表未知投递可以自动重放。

工具源码是 [restore-drill.py](../scripts/restore-drill.py)，复用相邻的 [backup-controller.py](../scripts/backup-controller.py)。[NyatDB 检查器](../scripts/restore-nyatdb-probe.mts) 只导入纯 TypeScript engine；[构建配置](../tsup.config.ts) 生成独立 bundle。运行时不依赖生产 node_modules、tsx、应用源码或应用配置。

## 安装与信任边界

由发布操作员将已测试、与发布 manifest 校验和一致的两个 Python 文件安装到 /opt/nyatbot-backup/app/scripts，独立 bundle 安装为 /opt/nyatbot-backup/app/dist/restore-nyatdb-probe.mjs。构建输出 dist/restore-nyatdb-probe.js 在安装时改为 .mjs，使该根目录不需要 package.json。所有代码、执行二进制、备份控制配置、rclone 配置与密码文件及其父目录必须由 root 管理，不能被组或其他用户写入，不能经过符号链接。不能直接从机器人用户可写的安装目录以 root 运行这些工具。

备份控制配置必须是 root:root 0600；quarantine 根目录必须是与生产和本地备份区不重叠的 root:root 0700 目录。使用当前备份配置的 drive crypt 与水位信息，不额外复制机器人密钥。对子进程清空继承环境；只有受控 PATH、私有 HOME/TMPDIR、locale，以及对应子进程必要的 rclone 或临时 Redis 密码。建议以 Python 隔离模式运行，排除 PYTHONPATH 和用户 site 包：

```sh
/opt/nyatbot-python/bin/python3.12 -I /opt/nyatbot-backup/app/scripts/restore-drill.py \
  --config /opt/nyatbot-backup/config.json \
  --run-id nyatbot-20261114T160000Z-abcdef123456
```

上面的 run-id 是语法示例，运行时必须替换为云端实际存在且已封存的代号。脚本接受严格的 nyatbot-日期时间-12 位十六进制格式，不接受路径或 shell 参数。默认执行二进制及端口在脚本 CLI 中固定；如修改位置，仍需通过相同信任检查。恢复目录下的私有配置、Redis/Qdrant 日志和数据只能保留在服务器上，不能作为聊天附件上传。

## 验证顺序与成功含义

1. 从 crypt 远端先读取 manifest 和 COMPLETE，再将整代下载到新的空目录。校验封存时间、manifest SHA、精确文件集合、各文件 SHA/大小；云端缺失或下载失败即失败，不使用本机原备份补齐。下载完成再校验一次 manifest/COMPLETE，防止代号内容中途变化。
2. 检查解包空间及 tar 路径/类型，调用控制器的 verify/restore_to_quarantine。所有恢复副本与云下载副本均保留，不覆盖既有目录，不执行归档内的代码。
3. SQLite 运行完整性、外键检查，迁移列表与 manifest 完全比较，重新计算备份水位并比较。stdout 仅返回计数与水位 hash，不返回业务记录。
4. 在额外工作副本上启动独立 Redis（默认 loopback 26379），等待 RDB 校验与加载完成；确认监听 socket 属于本次启动的 PID，统计恢复实例的 DB 数和 key 数。原 manifest 没有逐 DB 的冻结 key 数，因此这一项是加载证明，不声称与备份前在线 key 数相等。
5. 在额外存储目录启动独立 Qdrant（默认 loopback 27333/27334），通过重复 snapshot 参数恢复所有集合。比较完整集合清单、dense/sparse 向量配置和冻结的精确 point count；从已校验的 metadata 重建缺失 aliases，再比较全部 aliases。生产 Qdrant 完全不参与这些 HTTP 操作。新备份在停写窗口调用 CountRequest 的 exact=true，将结果保存为 metadata.exactCounts。旧代缺少这个字段时，仍验证加载、结构和恢复后的计数，但回执 pointsMatched=null，明确没有冻结精确计数可供比较。存在但不完整或类型错误的 exactCounts 必须失败，不能退回旧模式。
6. 再复制一份 NyatDB，独立 bundle 用 verifyOnOpen 加全页 CRC 检查打开；从实际 chat 页提取 scope，最多取三个会话、各三条记录验证 recent/get 一致，并验证不存在的 scope 不返回数据。检查的聊天正文不出进程。全页完整性验证与抽样索引验证是两个不同保证，不能将抽样描述为逐条业务恢复验收。

Redis 和 Qdrant 均只有私有 loopback 端口及每次生成的认证信息；配置中的生产端口、重复或已占用端口会提前拒绝。确认 /proc socket inode 属于本次 Popen PID 后才接受健康或数据响应，防止竞争绑定后误验生产服务。

Qdrant v1.18 的 [CollectionInfo 定义](https://api.qdrant.tech/v-1-18-x/api-reference/collections/get-collection.md) 明确将 points_count 标为近似值；[Count points 接口](https://api.qdrant.tech/v-1-18-x/api-reference/points/count-points.md) 的 exact=true 才返回精确计数。两者不作为同一口径比较。

## 回执、故障与清理

stdout 和新工作目录下的 RESTORE_DRILL.json 只含聚合回执：状态、阶段、runId、校验值、计数、时间与 childrenStopped。任何阶段异常都退出非零；原始异常内容不进入回执。已经完成的阶段保留，未执行阶段不能被标为成功。

正常完成、异常、SIGTERM 或 SIGINT 都只关闭本次 Popen 子进程：先 terminate 和有限等待，必要时 kill 并等待；不按名称杀进程、不调用生产 systemd、不清除旧备份或本次恢复数据。SIGKILL/主机断电无法执行 Python finally，此工具不声称能自动清理这种情况；运维应在独立 service/cgroup 中运行，并检查遗留进程、目录和端口后再演练。未知投递记录保留原状态，后续人工核对独立于本工具。

本地测试使用合成云传输和真实 SQLite/NyatDB，Redis 与 Qdrant 的真实 RDB/snapshot 加载由服务器演练产生证据。在该演练完成前，不将测试通过写成“云端恢复已成功”。测试入口：

```sh
python3 -m unittest discover -s tests/ops -p test_restore_drill.py -v
```
