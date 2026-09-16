# Monitor UI 重构 — 仿 Telegram Web 风格

**目标：** 完全重写 `/root/xxb-ts/monitor/index.html`，仿 Telegram Web/Desktop 的聊天界面。

**只改这一个文件，纯 HTML+CSS+JS，不用框架。**

## 布局

```
┌─────────────────────────────────────────────────┐
│ 左侧 300px 侧边栏    │  右侧消息区               │
│                      │                          │
│ ┌──────────────────┐ │  ┌─ 顶栏：群名 ─────────┐ │
│ │ 🔍 搜索框        │ │  │ 群名  ·  N 位成员     │ │
│ ├──────────────────┤ │  ├──────────────────────┤ │
│ │ 群名             │ │  │                      │ │
│ │ 最后消息预览 时间  │ │  │  [用户名]            │ │
│ │──────────────────│ │  │  ┌────────────┐      │ │
│ │ 群名             │ │  │  │ 灰色气泡    │ 时间 │ │
│ │ 最后消息预览 时间  │ │  │  └────────────┘      │ │
│ │──────────────────│ │  │                      │ │
│ │ ...              │ │  │       ┌────────────┐ │ │
│ └──────────────────┘ │  │  时间 │ 紫色气泡    │ │ │
│                      │  │       └────────────┘ │ │
│                      │  │                      │ │
│                      │  │  ── 日期分隔线 ──     │ │
│                      │  │                      │ │
│                      │  └──────────────────────┘ │
└─────────────────────────────────────────────────┘
```

## CSS 规范

```css
:root {
  --bg-main: #0e0e0e;
  --bg-sidebar: #1a1a1a;
  --bg-sidebar-hover: #252525;
  --bg-sidebar-active: #2a2a2a;
  --bg-header: #1e1e1e;
  --bg-bubble-user: #2a2a2a;
  --bg-bubble-bot: #6b21a8;
  --fg: #f0f0f0;
  --fg-muted: #888;
  --fg-time: #666;
  --accent: #c084fc;
  --border: #222;
  --bubble-radius: 12px;
  --bubble-max-width: 70%;
}
```

## 消息气泡

- 用户消息：靠左，灰色背景 `--bg-bubble-user`，左上角方角其余圆角
- Bot 消息：靠右，紫色背景 `--bg-bubble-bot`，右上角方角其余圆角
- 用户名：彩色（基于 uid hash 分配 8 种颜色），只在群聊第一条或换人时显示
- 时间戳：气泡右下角，小字灰色
- 连续同一用户的消息不重复显示用户名

## 日期分隔线

消息之间如果跨天，显示居中的日期标签：`── 4月19日 ──`

## 群聊列表

- 每项：群名（粗体）+ 最后消息预览（灰色截断）+ 时间（右上角）
- 选中项高亮 `--bg-sidebar-active`
- hover 效果 `--bg-sidebar-hover`
- 按最后消息时间倒序排列

## 移动端（≤600px）

- 默认显示群列表全屏
- 点击群聊后隐藏列表，全屏显示消息
- 顶栏左侧加 ← 返回按钮

## 认证页

- 居中卡片，密码输入框 + 登录按钮
- 暗色主题，圆角卡片

## JS 逻辑

```js
const TOKEN = localStorage.getItem('monitor_token');
const API = '/monitor/api';

// 1. 加载群列表
fetch(`${API}/chats?token=${TOKEN}`)

// 2. 点击群聊加载消息
fetch(`${API}/messages?token=${TOKEN}&chat_id=${chatId}&limit=50`)

// 3. 长轮询
async function poll(chatId, afterIdx) {
  const res = await fetch(`${API}/poll?token=${TOKEN}&chat_id=${chatId}&after=${afterIdx}`);
  // 追加新消息，更新 afterIdx，继续 poll
}
```

## 用户名颜色

```js
const COLORS = ['#ff6b6b','#ffa94d','#ffd43b','#69db7c','#38d9a9','#4dabf7','#748ffc','#da77f2'];
function nameColor(uid) { return COLORS[Math.abs(uid) % COLORS.length]; }
```

## API 端点（已实现，不需要改后端）

- `GET /monitor/api/chats?token=xxx` → `{ chats: [{ chatId, title, lastMessage, lastTimestamp }] }`
- `GET /monitor/api/messages?token=xxx&chat_id=xxx&limit=50` → `{ messages: FormattedMessage[] }`
- `GET /monitor/api/poll?token=xxx&chat_id=xxx&after=idx` → `{ messages: FormattedMessage[] }`
