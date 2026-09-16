# Nyatbot Meta+Subagent 切流清单

## 现状（2026-07-21）

- 编排已在 **xxb-ts** 落地，flags **默认关闭** → 生产仍走原 pipeline/turn-actor。
- 文档：`docs/meta-subagent/README.md`

## 灰度步骤

1. 选一个测试群 chatId（负数）。
2. `.env` 增加：
   ```
   META_SUBAGENT_ENABLED=true
   META_SUBAGENT_CHAT_IDS=<测试群id>
   DREAM_JOURNAL_ENABLED=true
   ```
3. `npm run build && sudo systemctl restart xxb-ts`
4. 在测试群 @bot，查日志：
   - `Meta attention ingested`
   - `Meta session start`
   - `CodeAct task start` / `CodeAct task done`
5. 确认日记目录 `data/dream-journal/` 在 cron 点后有文件（也可临时手动 `npx tsx -e "import('./src/cron/dream-journal.ts').then(m=>m.runDreamJournal())"` 需先 load env）。

## 回滚

- 去掉或设 `META_SUBAGENT_ENABLED=false`，重启 → 立即回到旧管线。
- 日记可单独关 `DREAM_JOURNAL_ENABLED=false`。

## 主群切流（以后）

1. 扩 `META_SUBAGENT_CHAT_IDS` 或清空列表（全开）。
2. 观察 24–48h：吞消息、双回复、禁词命中、CodeAct 超时 fallback。
3. 保留旧代码路径至少一周（flag off 即回滚）。

## 退役旧管线（更后）

待 Meta 路径稳定后再谈删除 turn-actor/gate——**现在不要删**。
