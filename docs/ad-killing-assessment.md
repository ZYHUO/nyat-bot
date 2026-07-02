# "杀广告" 现状诊断（2026-07-02）

结论:当前 xxb-ts **没有"杀广告"能力,只有"对广告降噪"**,且是半成品。本文档存档诊断 + 将来若要做的方案骨架(用户已定检测手段=规则+LLM 混合;处置力度待定,当前决定「先不动」)。

## 现状(代码事实)

### 1. 只认机器人发的广告,不认人发的
`src/tracking/bot-classifier.ts:45` — `classifyBotMessage` 第一行 `if (!m.isBot) return 'unknown'`。**人类用户刷广告永远不会被判成 `ad`。**
- 检测规则窄(`:22-23`):必须"促销词(机场/订阅/套餐/节点/流量…)"AND"报价词(最低X元/免费送/💎🎁/限时/首月…)"同时命中。漏软广、拉群、U 商、招嫖、二维码图广、纯 emoji 引流。

### 2. 判成广告后只"降噪",不删不禁
`src/pipeline/pipeline.ts:466-475` — `isDenoiseBot`(`BOT_DENOISE_ENABLED`,.env 已开)分支:注释「**已在 ctx,不删**」→ tracking-only,不烧 judge/heart,直接 return。
- 即:广告消息照常存进上下文,只是 bot 自己不回应/不学它。**无 deleteMessage / mute / restrict / ban。**
- `suggestedBotAction('ad') === 'suppress'`(`bot-classifier.ts:65`)语义就是"降噪",非"杀"。

### 3. 处置原语都在,但没接到广告检测
- `deleteMessage`(`src/bot/sender/telegram.ts:160`)只用于占位消息清理(deliver.ts)。
- `banChatMember`/`restrictChatMember`(`src/verification/cleanup.ts:29-38`)只用于**入群验证**踢未验证者。
- 二者与广告检测零连线。

### 4. 唯一真删真封的广告逻辑管的不是群
`src/pipeline/dm-relay/safety.ts` 有 AI spam 检测(`:59` checkSpam,confidence≥0.7)+ 5 次阈值封禁(`SPAM_BAN_THRESHOLD`)——但那是**私聊转达功能**里挡 spam,不是群里杀广告。

## 半成品清单

| 要素 | 现状 |
|---|---|
| 人类用户广告检测 | ❌ 完全没有(只认 bot) |
| 检测覆盖 | ⚠️ 窄正则,仅机场/订阅类 |
| 处置动作 | ❌ 只降噪不理,不删不禁 |
| admin 门控 / 防误杀 | ❌ 无 |

## 将来若要做:方案骨架(未实施)

用户已定:**检测手段 = 规则 + LLM 混合**;处置力度未定(选项:①影子跑只报不杀 ②删消息不封人 ③删+禁言/踢)。建议按此分期:

1. **检测层**(新 `src/pipeline/judge/ad-detect.ts` 或并入 judge L0):
   - 硬规则先招明显广告(拉群链接 t.me/+、U 商、招嫖黑话、机场促销、二维码图 caption)→ 0ms 免费。
   - 可疑的交便宜 LLM(现成 `usage:'judge'`/`'summarize'`)上置信度,输出 `{is_ad, confidence, reason}`。
   - **人类消息**才走这层(bot 广告已有 denoise);老群友(高好感/高 dunbar/发言数)白名单跳过。
2. **影子期**(强制先做):命中只 `logger.info('ad detected (shadow)')` 不动作,人工核对精度+误杀率,像 bot-classifier 当初 shadow 一样。
3. **处置层**(flag 门控、默认关、先灰度群):
   - admin 门:`bot.api.getChatMember(chatId, botUid)` 确认 bot 是管理员且有删/禁权限,否则只记不动。
   - 动作按力度:deleteMessage → 可选 restrictChatMember(禁言 N 分钟)→ 可选累犯 ban。
   - 防误杀硬门:高置信阈值(如 ≥0.85)+ 老群友白名单 + 每群每小时处置上限 + 可选管理员复核队列。
4. 复用现有:`deleteMessage`/`restrictChatMember`/`banChatMember` 原语、`callWithFallback` LLM 路由、env flag+灰度群模板、`getRelationship`/dunbar 做白名单。

**风险提示**:处置层是对外、不可逆、易误伤真人的操作。上线务必影子期→高阈值→灰度→admin 门四重保险,任何一层缺失都可能误踢真群友。
