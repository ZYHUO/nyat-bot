# NyatDB — 生产就绪说明

> Workspace 包：`@nyat/nyatdb`（[`packages/nyatdb`](../../packages/nyatdb)）。公开镜像：[ZYHUO/nyatdb](https://github.com/ZYHUO/nyatdb)。宿主适配：[`src/nyatdb/`](../../src/nyatdb/)（`NYATDB_*` → 包 API）。模块地图见 [`docs/modules.md`](../modules.md)。

NyatBot **专用**页式嵌入式引擎（非 Redis 壳 / 非通用 SQL）。

## 能力（v3）

| 原语 | API | 说明 |
|------|-----|------|
| ChatLog | `chatAppend` / `chatRecent` / `chatGet` / `chatTrimKeepLast` | 追加日志 + tip 热环 + **二级索引** |
| HotState | `hotSet` / `hotGet` / `hotDel` | 热状态 |
| Impulse | `impulseSchedule` / `impulseDue` / `impulseAck` | 延时任务 |
| Bond | `bondUpsert` / `bondList` | 关系 |
| Recall | `recallUpsert` / `recallSearch` | 384-d 召回 |
| 运维 | `checkpoint` / `verify` / `stats` | 压实 + CRC 校验 |

### 存储布局

```text
data/nyatdb/
  ENGINE.json
  heap.ndb              # 4KB slotted pages
  wal/redo.wal          # checkpoint 后 rotate 清空
  snap/msg.idx          # (chatId,messageId)→page/slot 二级索引快照
```

### 生产开关

```bash
NYATDB_ENABLED=true
NYATDB_PATH=./data/nyatdb
NYATDB_DUAL_WRITE=true          # Redis ctx 双写 ChatLog
NYATDB_READ=false               # true → getRecent/getAll 优先读 NyatDB（空则回退 Redis）
NYATDB_NATIVE=true              # 走 Rust addon（需 npm run build:nyatdb）
NYATDB_SYNC_EVERY=8
NYATDB_POOL_FRAMES=128
NYATDB_CHAT_RING_MAX=200
NYATDB_MAX_MESSAGES_PER_CHAT=5000
NYATDB_VERIFY_ON_OPEN=false     # 大库建议定期手工 verify
```

双写：[`context/manager.ts`](../../src/pipeline/context/manager.ts) 在 `addMessage` 成功写 Redis 后镜像到 NyatDB（失败只打日志，不挡主路径）。

ChatLog body：**algo 0/1** = 纯文本（旧）；**algo 2/3** = FormattedMessage JSON（±zstd），读写路径用 [`chat-log.ts`](../../src/nyatdb/chat-log.ts) pack/unpack，保证 `slimContext` 仍有 username / 贴纸 / 回复链。

### 存量迁移

```bash
# Redis xxb:ctx:* → ChatLog；SQLite chat_relationships → Bond；lastspoke → Hot
npx tsx scripts/migrate-to-nyatdb.ts --fresh --native
```

建议顺序：停服或低峰 → `--fresh` 迁一次 → 开 `ENABLED`+`DUAL_WRITE`（`READ` 先关）→ 观察 → 再开 `READ`。

### 恢复

1. 停服  
2. 拷贝整个 `NYATDB_PATH`  
3. 启服；打开时加载 `msg.idx`（LSN 对齐）或全量重建索引 + WAL replay  

### 原生引擎（Rust / napi-rs）— 进行中

目标：进程内 addon（方案 A），整引擎重写，多核 + 逼近 SQLite PK。

| Step | 内容 | 状态 |
|------|------|------|
| 1 | crate scaffold + napi load + `NYATDB_NATIVE` | 完成 |
| 2 | page / heap / WAL / CRC + WAL replay + safe Drop | 完成 |
| 3 | ChatLog + Hot + Impulse + Bond + Recall + 索引 | 完成 |
| 4 | TS facade + `chatGetBatch`(rayon) + bench | **完成** |

```bash
npm run build:nyatdb          # release addon → native/nyatdb/*.node
NYATDB_NATIVE=true            # getNyatDb() 走 Rust facade（需先 npm run build:nyatdb）
```

源码：[`packages/nyatdb/`](../../packages/nyatdb/)（`@nyat/nyatdb`）· 宿主适配：[`src/nyatdb/`](../../src/nyatdb/) · loader：[`packages/nyatdb/src/native.ts`](../../packages/nyatdb/src/native.ts)


### 点查性能 / 内存（TS 引擎）

- **二级索引**是 `chatId → messageId → packed(page,slot)` 嵌套 Map（无字符串 key）；不是泄漏，生产靠 `NYATDB_MAX_MESSAGES_PER_CHAT` + `chatTrimKeepLast` 封顶。
- 热路径：`pool.peek` + `getTupleView`（零拷贝）+ 读读默认不做 CRC（`verify()` / `VERIFY_ON_OPEN` 才全量 CRC）。
- 页全在 pool 内时，`chatGet` 可逼近 SQLite PK（同量级 μs）；随机扫超大堆且 pool 装不下时会打磁盘，慢于 SQLite（SQLite 吃 OS page cache / 原生 B-tree）。
- **TS 引擎不会自动用多核**：`Promise.all(100)` 只是排队。原生引擎（上表）内部用线程池吃多核。

```bash
BENCH_MSGS=100000 CONCURRENCY=100 npx tsx scripts/bench-nyatdb-pk-concurrent.ts
BENCH_MSGS=50000 npx tsx scripts/bench-nyatdb-native.ts   # native vs TS vs SQLite
```

### 尚未替换（仍用旧栈）

- BullMQ / 全量 Redis 热键 → 后续 Impulse + HotState 迁徙  
- Qdrant → Recall + MiniLM 接线  

生产建议：**先开 `DUAL_WRITE` 观察一周**，确认 `chatGet`/体积/checkpoint 正常，再切读路径。
