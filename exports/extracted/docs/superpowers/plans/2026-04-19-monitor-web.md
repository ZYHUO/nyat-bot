# 群聊监控 Web — 只读 TG 风格消息查看器

---

## 后端 API（加到 Hono）

**文件：** 新建 `src/admin/monitor.ts`，在 `src/index.ts` 挂载到 `/monitor`

### 端点

1. `GET /monitor/chats` — 列出所有有消息的群聊
   - 从 Redis SCAN `xxb:ctx:*` 获取所有 chatId
   - 对每个 chatId 调 `tryGetChat` 获取群名
   - 返回 `[{ chatId, title, username, lastMessage, unread }]`

2. `GET /monitor/messages?chat_id=xxx&limit=50&before=messageId` — 获取消息
   - 从 Redis LRANGE 获取最近 N 条
   - 返回 `FormattedMessage[]`

3. `GET /monitor/poll?chat_id=xxx&after=messageId` — 长轮询新消息
   - 每秒检查一次，有新消息立即返回，30 秒超时返回空

**认证：** 复用 Telegram WebApp HMAC 认证，只允许 master 访问

---

## 前端（静态 HTML + CSS + JS，不用框架）

**文件：** 新建 `monitor/index.html`，Hono 用 serveStatic 挂载到 `/monitor`

### 布局（仿 Telegram Desktop）

```
┌──────────────────────────────────────────┐
│  titlebar: 群聊监控 (traffic lights)      │
├────────────┬─────────────────────────────┤
│ 群聊列表    │  消息区域                    │
│            │                             │
│ [群名]     │  [时间] 用户名               │
│ 最后一条... │  消息内容                    │
│            │                             │
│ [群名]     │  [时间] 用户名               │
│ 最后一条... │  消息内容                    │
│            │                             │
├────────────┴─────────────────────────────┤
│  footer: 只读模式 · Powered by 啾咪囝     │
└──────────────────────────────────────────┘
```

### 样式
- 复用 miniapp 的 macOS 暗色主题（CSS 变量）
- 左侧 250px 固定宽度，群聊列表可滚动
- 右侧消息区域，消息气泡样式
- bot 消息靠右紫色气泡，用户消息靠左灰色气泡
- 消息带时间戳、用户名、头像占位符
- 移动端响应式：左侧全屏列表，点击进入消息

### JS 逻辑
- 页面加载时 fetch `/monitor/chats`
- 点击群聊 fetch `/monitor/messages?chat_id=xxx`
- 长轮询 `/monitor/poll` 实时更新
- 新消息自动滚动到底部
- 认证：URL 参数带 `init_data`（从 Telegram WebApp 获取）或简单密码

---

## 技术约束
- 纯 HTML/CSS/JS，不用框架，不用构建工具
- 复用 miniapp 的 CSS 变量和 macOS 窗口样式
- 只读，无发送功能
- Master 认证
