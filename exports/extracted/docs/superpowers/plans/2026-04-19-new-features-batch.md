# 新功能批量实现 Plan

---

## 1. 投票工具 CREATE_POLL

**新建文件：**
- `src/pipeline/tools/poll.ts`

**修改文件：**
- `src/pipeline/tools/registry.ts` — 注册 CREATE_POLL

**实现：**
```ts
// poll.ts
import { getBot } from '../../bot/bot.js';
export async function executePoll(chatId: number, question: string, options: string[]) {
  await getBot().api.sendPoll(chatId, question, options);
  return { ok: true };
}
```
registry.ts 注册：参数 question(string) + options(string[], 2-10个)

---

## 2. 话题追踪 @提醒

**新建文件：**
- `migrations/0012_topic_watches.sql`
- `src/tracking/topic-watch.ts`

**修改文件：**
- `src/pipeline/judge/rules.ts` — 加 /watch /unwatch /watches 到 WHITELISTED_COMMANDS + L0 规则
- `src/pipeline/pipeline.ts` — 处理命令 + 每条消息 fire-and-forget checkWatches

**SQL：**
```sql
CREATE TABLE IF NOT EXISTS topic_watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  keywords TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER,
  UNIQUE(chat_id, uid, keywords)
);
```

**topic-watch.ts 导出：** addWatch, removeWatch, listWatches, checkWatches

---

## 3. 数据统计

**新建文件：**
- `migrations/0013_daily_stats.sql`
- `src/tracking/stats.ts`

**修改文件：**
- `src/pipeline/pipeline.ts` — 每条消息 recordMessage, bot 回复 recordBotReply
- `src/cron/scheduler.ts` — 每小时 flushDailyStats

**stats.ts：** 内存 Map 计数，flushDailyStats 写 SQLite，getStats 读取

---

## 4. 猜数字游戏

**新建文件：**
- `src/pipeline/games/manager.ts`
- `src/pipeline/games/guess-number.ts`

**修改文件：**
- `src/pipeline/judge/rules.ts` — /game 命令
- `src/pipeline/pipeline.ts` — 游戏拦截逻辑

**manager.ts：** activeGames Map<chatId, Game>，start/play/stop
**guess-number.ts：** 1-100 随机数，提示大了/小了，5分钟超时

---

## 5. RAG 增强

**修改文件：**
- `src/pipeline/context/retriever.ts` — direct 模式恢复 semantic search

**改动：** 把 direct 分支中 `semantic = []` 改回调用 `retrieveSemantic`，保留 token 预算检查

---

## 6. 积分系统

**新建文件：**
- `migrations/0014_reputation.sql`
- `src/tracking/reputation.ts`

**修改文件：**
- `src/pipeline/judge/rules.ts` — /rank /points 命令
- `src/pipeline/pipeline.ts` — 签到+10, 每日发言+1(上限5), 处理 rank/points 命令

**reputation.ts 导出：** addPoints, getReputation, getLeaderboard, resolveLevel
**等级：** 0-99 bronze, 100-499 silver, 500-1999 gold, 2000-9999 platinum, 10000+ diamond
