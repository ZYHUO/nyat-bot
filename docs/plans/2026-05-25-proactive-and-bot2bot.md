# NyatBot: 主动参与 + Bot对聊 10回上限

## 问题诊断

### 为什么 bot 不插嘴？
5层过滤器几乎封死了休闲对话：

1. **L0 `recent_reply`** — bot 最近 10 条消息内回复过 → IGNORE
2. **L0 `hot_chat`** — 5分钟内10条消息 → 70%跳过，25条 → 100%跳过
3. **Judge prompt 规则** — "有人分享链接/图片且未向你提问 → ❌IGNORE"  
4. **JUDGE_PROACTIVE_ENABLED 默认 false** — 主动参与完全关闭
5. **Timing Gate** — 即使 judge 说 REPLY，gate 还能压回

### 为什么 bot-to-bot 只有1轮？
L0 `bot_fatigue` 阈值写死 `consecutiveBotMsgs >= 2` → 最多1次回复

---

## 修改计划

### Task 1: Bot-to-Bot 10回合限制

**文件**: `src/pipeline/judge/rules.ts` (lines 199-233)

当前逻辑:
- Gate 1: bot 没点名/回复自己 → IGNORE
- Gate 2: 人类在场 → IGNORE  
- Gate 3: 连续2条bot消息 → IGNORE

改为:
- Gate 1: 保留（bot没叫自己不回复）
- Gate 2: **删除** — 允许人类在场时bot也参与
- Gate 3: 改为 `consecutiveBotMsgs >= 20`（每边10轮 × 2条 = 20条连续bot消息）

**文件**: `src/tracking/outcome.ts` (line 65)
- 删除 `if (currentMessage.isBot) return { needsReflection: false }` — 允许 bot 消息也反思

**文件**: `prompts/task/judge.md` (line 41 附近)
- 把 "bot消息除非@你→IGNORE" 改为: "与bot对聊时最多10回合→自然收尾"

**文件**: `prompts/task/reply.md`
- 加一条: "与bot对话时，到第8-9回合开始自然收尾，不强行停止"

### Task 2: 主动参与 — 让 bot 更活泼

**文件**: `src/pipeline/judge/rules.ts`

2a. `recent_reply` 阈值从 10 → 5（line 374附近）
- 当前10条内bot回复过就IGNORE，太保守

2b. `hot_chat` 阈值放宽（line 352附近）
- 70%跳过的阈值从 10 → 15 条
- 100%跳过从 25 → 40 条

2c. 新增: 链接/时间类消息的特殊通道
- 不再在 L0 一刀切 IGNORE
- 让 L1 AI judge 决定是否参与讨论

**文件**: `prompts/task/judge.md`

删除 "分享链接/图片且未向你提问 → ❌IGNORE"
改为: "分享链接 → 看内容决定是否参与讨论，可以发表评论或吐槽"

2d. 启用主动参与（需改 .env 或 Redis override）
- `JUDGE_PROACTIVE_ENABLED=true`
- `JUDGE_PROACTIVE_RATE=0.15`（从5%提到15%）
- `JUDGE_PROACTIVE_MIN_INTERVAL_SEC=180`（从600秒降到3分钟）

### Task 3: 构建测试

- `npm run build` 确保编译通过
- `systemctl restart xxb-ts` 重启验证无报错