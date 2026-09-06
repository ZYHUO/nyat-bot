# Core v2 总览

> 状态：Phase 0–4 已全部上线（v0.5.0）。本文是三个月后的自己/接手人看的——先读这篇，再碰 `src/core/`。

## 一句话

Core v2 是 bot 的第二套认知地基：**belief（信念）管"记得什么"，drives（驱动）管"想做什么"，lifecycle（门）管"技能怎么长出来"**。旧系统（profiles/norms/goals/skills 表 + unified-tick）继续当**唯一真相来源和执行器**，core 只做**读投影 + 打分 + 否决**——旧行为零触碰，出事一刀切能关。

## 架构（三层，都是"只建议/只否决，不执行"）

```
旧系统（真相 + 执行，全部保留）
  user_profiles / person_identity / group_norms / goals / world_entities / skills
  unified-tick（cron ticker） / pipeline judge / subagent executor
        │ 双写（fire-and-forget，失败只打日志）
        ▼
Core v2（读投影 + 策略）
  core_beliefs        ← 5 张旧表的统一读视图（Phase 2）
  core_drives         ← connection/curiosity/competence/autonomy（Phase 3）
  core_blackboard     ← L0/L1/proposal 留痕 + L2 快照隔离（Phase 0/1）
  core_skill_lifecycle← skill 的门：propose→verify→approve→publish（Phase 4）
```

铁律（四个 phase 通用）：

1. **不重构旧表，只加薄基础设施**——新表全是增量 migration，旧表一列不动。
2. **置信度/状态只由 host 可验证 outcome 更新**——LLM 提供内容，host 推状态。LLM 自己批不了自己。
3. **未知/失败一律 fail-soft**——双写失败不拦旧路，suppressor 抛错不拦 tick，prompt 组装抛错则逐字节回退。
4. **总开关**：`CORE_V2_ENABLED=false` 一刀切（shadow 零开销）；`CORE_DUAL_WRITE=false` 停更 belief。

## Phase 谱系（commit 可查）

| Phase | 落点 | 表 | 做了什么 |
|---|---|---|---|
| 0 地基 | `a8d8912` (#70) | 0083 `core_beliefs`（实际叫 core_belief_view 相关）、0084 `core_blackboard` | belief store + Laplace 置信度 + 矛盾检测 + 黑板 ACL + permission gate + 快照隔离 + eval harness（`scripts/eval-belief-view.ts`，离线独立实现） |
| 1 分层 | `83666b0` (#71) | — | `runCoreTick`（L0 复用 l0Rule / L1 复用 microJudge / L2 全 dry-run）+ `assembleState` + `assembleSystemPrompt` + pipeline shadow 钩子（只记 `core shadow compare` 日志，不改行为） |
| 全开 | `ed8b64` (#72) | — | `isCoreChat` 空名单=全量（与 TURN_ACTOR 一致）；`CORE_V2_ENABLED` 总开关 |
| 2 迁移 | `dbcab32` (#73) | —（复用旧表） | `src/core/migrate.ts`：5 张旧表→belief 双写（`CORE_DUAL_WRITE`）；L1 的 judge 请求带 `[当前信念]` 段（≤`BELIEF_VIEW_INJECT_MAX`=4） |
| 3 驱动 | `a5f124f` (#74) | 0085 `core_drives` | `deriveDriveValues` + `proposeActions`（候选动作）+ tick prompt 拼增益排序 + `suppress`（satiation≥0.5 否决）+ 执行后 `satiate` |
| 4 技能门 | `05af8e4` (#75) | 0086 `core_skill_lifecycle` | propose→verify（红线+去重）→approve（人审唯一门）→publish（调旧 saveSkill）；`pruneExpiredProposals`（30d） |

## 表语义速查

**core_beliefs**：`(source_table, source_row_id, predicate)` 唯一——同源同谓词只更新 summary，不插新行、不重置 confidence。新 belief confidence=0.5（Laplace 先验），靠 `recordOutcome` 的 host-verified support/refute 收敛。无 evidence 不落库（`upsertBelief` 直接抛错）。

- predicate 映射：`group.norm`（group_norms）/ `person.interest`（user_profiles，本群最新）/ `person.trait`（person_identity，跨群）/ `entity.status`（world_entities）/ `goal.state`（仅 active goals）。
- 刻意不进的：world_entities 里 1900+ 条 topic 回复指令是噪音（`syncWorldEntity` 只在 upsert 时同步单条，历史噪音不回填）。

**core_drives**：value 由 tick 每轮 `deriveDriveValues` 重算并 `setDriveValue`；satiation 由执行后 `satiate(name)` 置 1，半衰期 6h 指数衰减（`CORE_DRIVE_SATIATION_HALFLIFE_SEC` 可配）。suppressor 只看 satiation 不看 value；quiet 永不拦。

**core_blackboard**：kind = observation（L0 留痕）/ proposal（L1 "我建议回/不回，因为…"，L2 可执行的 plan 永不直接写）/ snapshot（L2 开工冻结）。读走 `visibleToL1`（contradicted 不可见）。

**core_skill_lifecycle**：published 之前 skill 永不进 `findRelevantSkills`（查不到=用不上）。`reviewer` 是主人 uid，host 侧从 Telegram 确认回调取——当前**还没有接线到 bot 命令**（approve 靠 host 直接调函数，这是 Phase 4 留的尾巴，见下）。

## Env 旗（全在 `src/env.ts`，CORE_ 前缀）

| 旗 | 默认 | 关掉会怎样 |
|---|---|---|
| `CORE_V2_ENABLED` | true | isCoreChat 全 false，shadow 零开销 |
| `CORE_V2_CHAT_IDS` | 空=全量 | 非空则只对名单群生效 |
| `CORE_DUAL_WRITE` | true | core_beliefs 停更，读侧照常 |
| `CORE_BELIEF_VIEW_ENABLED` | true | assembleState 不读 belief |
| `CORE_BLACKBOARD_ENABLED` | true | 黑板不写 |
| `CORE_PERMISSION_GATE_ENABLED` | false | L2 真执行门（Phase 2 没开，因为 L2 全 dry-run；开真执行那天再开） |
| `BELIEF_VIEW_INJECT_MAX` | 4 | prompt 里 `[当前信念]` 上限 |
| `CORE_DRIVE_SATIATION_HALFLIFE_SEC` | 21600 | satiation 半衰期（store 里读 `process.env` 直值，防循环依赖——改 env.ts 时注意这一处是直读） |

## 验收口径（怎么知道它还活着）

- `grep -a -c "core shadow compare" logs/app.log` —— 每条 L0-miss 消息一条，有 `agree:true/false`（core vs legacy 动作对比）。
- `SELECT name, value, satiation FROM core_drives` —— tick 每 5 分钟重写 value；satiation=1 说明刚执行过同类动作。
- `grep -a "vetoed by drive satiation" logs/app.log` —— suppressor 开张记录（Phase 3 的"连续 3 天不刷屏"从这里看）。
- `SELECT status, COUNT(*) FROM core_skill_lifecycle GROUP BY 1` —— 门里的候选数。
- `npx tsx scripts/eval-belief-view.ts` —— 离线 harness（毒化/ttl/越权/P99），exit 0 为过。

## 已知的尾巴（下次开工从这里起）

1. **approve 没接线到 Telegram**：`approveSkill(id, reviewerUid)` 现在只能 host 直接调。下一步是加个主人 DM 命令（如"通过 skill #N"），reviewer 从 Telegram uid 取。
2. **`CORE_PERMISSION_GATE_ENABLED` 没开**：L2 还是全 dry-run。开真执行 = Phase 5（gate 接 promote.ts 的 authorized_intent）。
3. **L1 的 `[当前信念]` 让 shadow 不再是同 prompt 对比**：agree 只比 action，prompt  diverged 是已知的、可接受的。如果哪天 agree 率掉了，先看是不是 belief 段带偏了 microJudge。
4. **`halflifeSec()` 直读 `process.env`**（store.ts）：当时为防循环依赖。改 env.ts 相关逻辑时别漏这一处。
5. **`syncUserProfile` 同 uid 跨群收敛到一条 belief**：故意的（跨群印象本就该收敛，person_identity 管跨群）。如果以后要分群画像，加 predicate 或 source 区分。
