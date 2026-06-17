# Monitor UI v4 — 显示原始贴纸/图片/文件

**改两个文件：**
1. `/root/xxb-ts/src/admin/monitor.ts` — 加 API 端点获取 Telegram 文件 URL
2. `/root/xxb-ts/monitor/index.html` — 前端渲染真实媒体

## 后端：文件 URL 代理

Telegram 文件需要通过 Bot API 获取临时 URL。

在 `monitor.ts` 加端点：

```
GET /file?token=xxx&file_id=xxx
```

实现：
```ts
api.get('/file', async (c) => {
  const fileId = c.req.query('file_id');
  if (!fileId) return c.json({ ok: false }, 400);
  try {
    const file = await deps.bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${deps.env.BOT_TOKEN}/${file.file_path}`;
    return c.redirect(url);
  } catch {
    return c.json({ ok: false, error: 'file_not_found' }, 404);
  }
});
```

这样前端可以用 `<img src="/monitor/api/file?token=xxx&file_id=xxx">` 直接显示图片。

## 前端：消息渲染改动

### 贴纸
- 有 `sticker.fileId` → 显示 `<img>` 标签，src 指向 `/monitor/api/file?file_id=xxx`
- 尺寸 128x128，无背景
- 加载失败 fallback 到大号 emoji

### 图片
- 有 `imageFileId` → 显示 `<img>`，最大宽度 300px，圆角 8px
- 点击可放大（简单的全屏预览）
- 下方显示 caption（如果有 textContent）

### 语音
- 显示播放按钮图标 + 时长条（纯视觉，不能播放）
- 样式：圆形播放按钮 + 灰色波形条

### 文件
- 显示文件图标 + 文件名 + 大小
- 可点击下载（链接到 /file API）

### 视频
- 显示视频缩略图（如果有 thumbnail）或播放图标
- 不能播放，只是占位

### 转发消息
- 如果 `isForwarded`，顶部显示 "转发自 xxx" 标签

### 回复引用
- 如果有 `replyTo`，气泡顶部显示引用条（紫色左边框 + 被引用内容预览）
