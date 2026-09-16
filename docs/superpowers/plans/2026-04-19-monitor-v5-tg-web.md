# Monitor UI v5 — 全面仿 Telegram Web

**只改 `/root/xxb-ts/monitor/index.html`**

参考 https://web.telegram.org 的视觉细节，逐项对齐。

## 1. 侧边栏

### 顶部栏
- 左上角汉堡菜单图标（纯装饰）
- 搜索框占满宽度，圆角 20px，灰色背景，左侧放大镜图标
- 搜索框 placeholder "搜索"

### 群聊列表项
- 头像 54px（TG 用 54）
- 右侧两行：第一行 群名(粗体) + 时间(灰色右对齐)，第二行 发送者名+消息预览(灰色)
- 选中项左侧 3px 紫色竖条
- 未读消息数 badge（圆形紫色，右下角）— 可以用消息数模拟
- hover 背景色过渡 0.15s
- 列表项高度 72px

## 2. 消息区

### 顶部栏
- 左侧：群名(粗体) + 下方成员数(灰色小字)
- 右侧：搜索图标 + 更多图标（纯装饰）
- 高度 56px，底部 1px 边框
- 移动端：左侧加 ← 返回箭头

### 消息背景
- TG 风格：不是纯黑，是深灰带微妙图案
- 用 CSS 渐变模拟：`background: linear-gradient(135deg, #0d1117 0%, #0e1117 100%)`

### 消息气泡
- 用户气泡：`#212121` 背景，左上角尖角（CSS triangle）
- Bot 气泡：`#6b21a8` 背景，右上角尖角
- 气泡内 padding: 6px 12px 8px
- 时间戳在气泡内右下角，半透明小字，和文字同行（float right）
- 连续同用户消息间距 2px，换用户间距 8px

### 气泡尖角（CSS）
```css
.msg-bubble.user::before {
  content: '';
  position: absolute;
  top: 0; left: -8px;
  border: 8px solid transparent;
  border-top-color: #212121;
  border-left: 0;
}
.msg-bubble.bot::before {
  content: '';
  position: absolute;
  top: 0; right: -8px;
  border: 8px solid transparent;
  border-top-color: #6b21a8;
  border-right: 0;
}
```
只在每组第一条消息显示尖角。

### 日期分隔
- 居中圆角标签：`background: rgba(0,0,0,0.3); backdrop-filter: blur(4px); border-radius: 16px; padding: 4px 12px`
- 字体 13px，半透明白色

### 链接
- 消息中的 URL 自动变成可点击链接（蓝色）

## 3. 滚动行为
- 新消息来时，如果用户在底部自动滚动，否则不滚动
- 显示"新消息 ↓"按钮（如果有未读且不在底部）
- 滚动到底部按钮：右下角圆形按钮，点击滚到底

## 4. 空状态
- 没选择群聊时，右侧显示居中的 logo + "选择一个聊天开始查看"
- 用 🐱 emoji 作为 logo

## 5. 加载状态
- 加载群列表时显示 skeleton 占位
- 加载消息时显示居中 spinner

## 6. 时间格式
- 今天的消息只显示 HH:MM
- 昨天显示 "昨天"
- 更早显示 MM/DD
- 侧边栏预览也用这个格式
