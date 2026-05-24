# xxb-ts: AI 审核修复 + 入群验证功能

## 目标

1. **修复 AI 审核**：`telegram_getchat` 为 null 时 AI 盲拒的问题
2. **新增入群验证**：新用户入群时需要通过验证才能发言，防自动化 bot

---

## 任务 1：修复 AI 审核 prompt

### 问题
`src/allowlist/ai-review.ts` 第 18 行 prompt："仅在确信群正常、无违规时输出 APPROVE"
→ 当 `getChat` 返回 null（bot 不在群里），AI 拿到 `telegram_getchat: null`，无法确认群正常 → 永远 REJECT

### 修复方案
在 `runAiReview()` 中，检测 `chatInfo === null` 时直接标记 `needs_manual`，跳过 AI 调用：

**文件**: `src/allowlist/ai-review.ts`
- 在 `chatInfo` 收集完毕后（~line 86），加判断：
  ```typescript
  if (!chatInfo && !recentContext) {
    request.review_state = 'needs_manual';
    request.ai_reason = 'Insufficient data: getChat returned null and no recent context';
    await redis.hset(`${config.redisPrefix}pending`, requestId, JSON.stringify(request));
    return { ok: true, decision: 'SKIP', confidence: 0, reason: '数据不足，需人工审核' };
  }
  ```
- 同时更新 prompt，在末尾追加：
  ```
  - 如果 telegram_getchat 为 null 且 recent_group_messages 为空，说明数据不可用，请输出 {"decision":"REJECT","confidence":0.3,"reason":"无法获取群组数据，建议人工审核"}
  ```

---

## 任务 2：入群验证功能

### 架构概览

```
新用户入群 → bot.on('new_chat_members')
  → 检查该群是否开启验证（SQLite）
  → 限制用户权限 (restrictChatMember, can_send_messages=false)
  → 私聊发送验证题目（InlineKeyboard）
  → 用户点击答案 → callback_query 处理
    → 正确：解除限制，通知群内
    → 错误：发送新题目或超时踢出
  → 记录到 SQLite
```

### 2.1 数据库：`migrations/0015_join_verification.sql`

```sql
-- 群组验证设置
CREATE TABLE IF NOT EXISTS group_verify_settings (
  chat_id INTEGER PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,           -- 默认关闭
  timeout_seconds INTEGER NOT NULL DEFAULT 300,  -- 5分钟超时
  max_attempts INTEGER NOT NULL DEFAULT 3,       -- 最多3次机会
  kick_on_fail INTEGER NOT NULL DEFAULT 0,       -- 失败后是否踢出
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 验证记录
CREATE TABLE IF NOT EXISTS verify_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT,
  challenge_type TEXT NOT NULL,       -- 'math' | 'logic'
  challenge_json TEXT NOT NULL,       -- {question, answer, options[]}
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'passed' | 'failed' | 'timeout' | 'kicked'
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  completed_at INTEGER,
  message_id INTEGER,                 -- 私聊验证消息 ID（用于编辑）
  UNIQUE(chat_id, user_id, started_at)
);

CREATE INDEX IF NOT EXISTS idx_verify_pending ON verify_records(chat_id, user_id, status);
```

### 2.2 题目生成：`src/verification/challenge.ts`

AI 自主出题，JSON 格式：

```typescript
interface Challenge {
  question: string;      // "12 + 7 × 3 = ?"
  answer: string;        // "33" (正确答案)
  options: string[];     // ["33", "27", "39", "21"] (4个选项，随机排列)
  type: 'math' | 'logic';
}
```

**出题策略**（AI 生成）：
- 使用 `allowlist_review` 或 `reply` 的 provider 调用 AI 出题
- System prompt 要求 AI 输出严格 JSON：
  ```json
  {"question": "12 + 7 × 3 = ?", "answer": "33", "options": ["33", "27", "39", "21"], "type": "math"}
  ```
- 题目类型：数学运算、逻辑推理、常识问答，难度适中
- 要求 AI 保证 answer 和 options 中的一项完全一致
- 随机种子注入 prompt（当前时间戳、用户 ID）确保每次题目不同

**防自动化**：
- AI 生成的题目表述天然多变，难以预训练
- 选项随机排列
- 限制答题时间（默认 5 分钟）
- JSON 格式固化，answer 和 options 必须精确匹配（避免 AI 模糊回答）

### 2.3 入群处理：`src/bot/handlers/join-verify.ts`

```typescript
// 监听新成员入群
bot.on('new_chat_members', async (ctx) => {
  for (const member of ctx.message.new_chat_members) {
    if (member.is_bot) continue;  // 跳过 bot
    const chatId = ctx.chat.id;
    const userId = member.id;

    // 检查该群是否开启验证
    const settings = getVerifySettings(chatId);
    if (!settings?.enabled) continue;

    // 限制用户权限
    await ctx.api.restrictChatMember(chatId, userId, {
      permissions: { can_send_messages: false, can_send_media_messages: false, ... }
    });

    // 生成题目
    const challenge = generateChallenge();

    // 私聊发送验证
    await sendVerificationDM(ctx.api, userId, chatId, challenge);
  }
});
```

### 2.4 回调处理：InlineKeyboard 回答

```typescript
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('verify:')) return;  // 不是验证回调

  const [, action, chatIdStr, answer] = data.split(':');
  const chatId = Number(chatIdStr);
  const userId = ctx.from.id;

  if (action === 'answer') {
    const record = getVerifyRecord(chatId, userId);
    if (!record || record.status !== 'pending') {
      await ctx.answerCallbackQuery({ text: '验证已过期', show_alert: true });
      return;
    }

    const challenge = JSON.parse(record.challenge_json);
    if (answer === challenge.answer) {
      // ✅ 正确 → 解除限制
      await ctx.api.restrictChatMember(chatId, userId, {
        permissions: { can_send_messages: true, can_send_media_messages: true, ... }
      });
      updateVerifyRecord(record.id, 'passed');
      await ctx.editMessageText('✅ 验证通过！你现在可以在群里发言了。');
      // 通知群内
      await ctx.api.sendMessage(chatId, `✅ ${ctx.from.first_name} 已通过验证`);
    } else {
      // ❌ 错误
      const newAttempts = record.attempts + 1;
      if (newAttempts >= record.max_attempts) {
        updateVerifyRecord(record.id, 'failed');
        await ctx.editMessageText('❌ 验证失败，你已被限制发言。请联系管理员。');
      } else {
        // 发新题目
        const newChallenge = generateChallenge();
        updateVerifyRecordChallenge(record.id, newChallenge, newAttempts);
        await ctx.editMessageText(..., buildInlineKeyboard(newChallenge));
      }
    }
    await ctx.answerCallbackQuery();
  }
});
```

### 2.5 DM 对话截断

**问题**：用户正在和 bot 对话时入群验证，需要暂停对话。

**方案**：用 Redis key 管理验证状态：
```
Key: xxb:verify:active:{userId}  → { chatId, startedAt }  TTL: 600s
```

**在 `src/pipeline/pipeline.ts` 中**：
- DM 消息处理前检查 `xxb:verify:active:{userId}`
- 如果存在且 status=pending → 不处理普通消息，回复"请先完成入群验证"
- 验证完成后删除 key，恢复正常对话

### 2.6 管理员管理

**InlineKeyboard 按钮**（私聊中给 admin）：
```
[✅ 通过]  [❌ 拒绝]  [🔄 重发题目]
```

当 admin 在群内看到某人申请验证时，或用户请求管理员介入时触发。

### 2.7 MiniApp 集成

**新增 API actions**（`src/admin/api.ts`）：
- `verify_get_settings` — 获取群验证设置
- `verify_set_enabled` — 开启/关闭群验证
- `verify_set_config` — 修改超时、最大尝试次数等

**MiniApp UI**（`miniapp-web/src/App.vue`）：
- 在群组卡片中增加"入群验证"开关
- 设置项：超时时间、最大尝试次数、失败后是否踢出
- 显示最近验证记录统计

### 2.8 环境变量

**`src/env.ts`** 新增：
- `VERIFY_ENABLED` — 全局是否启用验证功能（默认 false）
- `VERIFY_DEFAULT_TIMEOUT` — 默认超时秒数（默认 300）
- `VERIFY_MAX_ATTEMPTS` — 默认最大尝试次数（默认 3）

---

## 文件变更清单

| 文件 | 变更 |
|------|------|
| `migrations/0015_join_verification.sql` | **新增** — 数据库表 |
| `src/verification/challenge.ts` | **新增** — 题目生成器 |
| `src/verification/store.ts` | **新增** — SQLite 操作 |
| `src/verification/keyboard.ts` | **新增** — InlineKeyboard 构建 |
| `src/bot/handlers/join-verify.ts` | **新增** — 入群验证 handler |
| `src/allowlist/ai-review.ts` | **修改** — 修复 null getChat |
| `src/pipeline/pipeline.ts` | **修改** — DM 消息拦截验证状态 |
| `src/index.ts` | **修改** — 注册新 handler |
| `src/env.ts` | **修改** — 新增验证环境变量 |
| `src/admin/api.ts` | **修改** — 新增验证 API actions |
| `miniapp-web/src/App.vue` | **修改** — 验证设置 UI |
| `src/bot/handlers/member.ts` | **可能修改** — 联动 |

---

## 实现顺序

1. ✅ 修复 `ai-review.ts` prompt（5 分钟）
2. 📦 数据库 migration
3. 🎯 题目生成器 `challenge.ts`
4. 💾 SQLite store `store.ts`
5. ⌨️ InlineKeyboard 构建 `keyboard.ts`
6. 🤖 入群验证 handler `join-verify.ts`
7. 🔀 Pipeline DM 拦截
8. 🌐 MiniApp API + UI
9. 🔧 index.ts 注册 + env 配置
10. 📝 Code review

---

## 风险与注意事项

- **InlineKeyboard 是全新模式**：项目之前没用过 callback_query，需要确保不和未来功能冲突
- **Telegram 限制**：bot 必须是群管理员才能 restrictChatMember
- **隐私**：验证记录包含 user_id，注意数据清理
- **超时处理**：需要定时任务检查超时的验证记录
- **多群场景**：用户可能同时加入多个群，每个群独立验证
- **DM 截断**：需要确保验证完成后正确恢复对话状态
