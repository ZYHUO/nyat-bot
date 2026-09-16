# Monitor UI v3 — 群组/私信分开 + 头像

**只改 `/root/xxb-ts/monitor/index.html`**

## 侧边栏改动

### 分类 Tab
侧边栏顶部加两个 tab：`群组` | `私信`
- 群组：chatId < 0 的
- 私信：chatId > 0 的
- 默认显示群组
- tab 样式：底部紫色下划线表示选中

### 头像
每个群聊/私信项左侧显示圆形头像占位符：
- 取群名/用户名的第一个字符
- 背景色基于 chatId hash（8 种颜色）
- 尺寸 48px，圆形，居中文字 20px 白色粗体
- 群组用群名首字，私信用用户名首字

### 列表项布局
```
┌──────────────────────────────┐
│ [头像]  群名           14:30 │
│         最后一条消息预览...   │
└──────────────────────────────┘
```
- 头像 48px 圆形
- 右侧：上行 群名+时间，下行 预览（灰色，截断单行）
- 用 flexbox 布局

## 消息区头像

每条消息（非连续同用户）左侧显示小头像：
- 32px 圆形
- 用户名首字 + hash 颜色
- bot 消息用紫色背景 + 🐱
- 连续同用户不重复显示头像（用 margin-left 占位）

消息布局改为：
```
用户消息：
[头像] [用户名]
       [气泡内容]

Bot 消息（靠右）：
              [用户名] [头像]
       [气泡内容]
```

## CSS 新增

```css
.avatar {
  width: 48px; height: 48px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; font-weight: 700; color: #fff; flex-shrink: 0;
}
.avatar-sm { width: 32px; height: 32px; font-size: 14px; }
.avatar-bot { background: var(--accent); }

.sidebar-tabs {
  display: flex; border-bottom: 1px solid var(--border);
}
.sidebar-tab {
  flex: 1; text-align: center; padding: 10px; cursor: pointer;
  font-size: 13px; font-weight: 600; color: var(--fg-muted);
  border-bottom: 2px solid transparent;
}
.sidebar-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

.chat-item { display: flex; align-items: center; gap: 12px; }
.chat-info { flex: 1; min-width: 0; }
.chat-name-row { display: flex; justify-content: space-between; }

.msg-row { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 4px; }
.msg-row.bot { flex-direction: row-reverse; }
.msg-avatar-placeholder { width: 32px; flex-shrink: 0; }
```

## JS 改动

1. `loadChats` 后分成 `groupChats` 和 `dmChats` 两个数组
2. 侧边栏 tab 切换时重新渲染列表
3. `createMsg` 加头像渲染逻辑
4. 头像颜色函数：`avatarColor(id)` 基于 hash

## 头像颜色
```js
const AVATAR_COLORS = ['#e17076','#eda86c','#a695e7','#7bc862','#6ec9cb','#65aadd','#ee7aae','#2196f3'];
function avatarColor(id) { return AVATAR_COLORS[Math.abs(id) % AVATAR_COLORS.length]; }
function avatarLetter(name) { return (name || '?').charAt(0).toUpperCase(); }
```
