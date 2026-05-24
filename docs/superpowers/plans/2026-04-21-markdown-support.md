# Bot 回复支持 Telegram MarkdownV2

## 背景

Telegram MarkdownV2 支持：`*粗体*` `_斜体_` `` `代码` `` ` ```代码块``` ` `~删除线~` `||剧透||` `[链接](url)`

但 MarkdownV2 要求转义这些特殊字符：`_ * [ ] ( ) ~ ` > # + - = | { } . !`

如果 AI 输出的文本包含这些字符但没正确转义，Telegram API 会报错 `Bad Request: can't parse entities`。

## 方案

**不让 AI 输出 MarkdownV2 语法**（太容易出错），而是：
1. AI 继续输出纯文本
2. 发送前用代码自动检测并转换常见格式
3. 发送时用 `parse_mode: 'MarkdownV2'`
4. 如果发送失败（解析错误），fallback 到纯文本重发

## 改动

### 1. 新建 `src/bot/sender/markdown.ts`

```ts
export function toMarkdownV2(text: string): string
```

- 先转义所有 MarkdownV2 特殊字符
- 然后还原 AI 可能输出的常见格式：
  - `**text**` → `*text*`（粗体）
  - `` `code` `` → `` `code` ``（行内代码，已是 MD 格式）
  - ` ```code``` ` → ` ```code``` `（代码块）
  - URL 自动变成可点击链接

### 2. 修改 `src/bot/sender/streaming.ts` 和 `src/bot/sender/telegram.ts`

`sendMessage` 和 `sendDirect` 加 `parse_mode: 'MarkdownV2'`，发送失败时 fallback 纯文本。

### 3. 修改 `prompts/task/reply.md`

允许 AI 使用基础格式：
- `**粗体**` 用于强调
- `` `代码` `` 用于代码/命令
- ` ```语言\n代码\n``` ` 用于代码块
- 不要求 AI 做转义，代码层处理
