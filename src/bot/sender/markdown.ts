// MarkdownV2 转换 — AI 输出纯文本/基础 Markdown，发送前转为 Telegram MarkdownV2

const SPECIAL_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

function escapeMarkdownV2(text: string): string {
  return text.replace(SPECIAL_CHARS, '\\$1');
}

/**
 * 将 AI 输出的文本转为 Telegram MarkdownV2 格式。
 * 支持：**粗体**、`行内代码`、```代码块```、URL 保护
 * 其余特殊字符自动转义。
 */
export function toMarkdownV2(text: string): string {
  if (!text.trim()) return text;

  let remaining = text;

  // 1. 提取代码块（```...```），保护不被转义
  const codeBlocks: string[] = [];
  remaining = remaining.replace(/```([\s\S]*?)```/g, (_, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(code);
    return `\x00CB${idx}\x00`;
  });

  // 2. 提取行内代码（`...`）
  const inlineCodes: string[] = [];
  remaining = remaining.replace(/`([^`\n]+)`/g, (_, code: string) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00IC${idx}\x00`;
  });

  // 3. 提取粗体（**...**）
  const bolds: string[] = [];
  remaining = remaining.replace(/\*\*([^*]+)\*\*/g, (_, content: string) => {
    const idx = bolds.length;
    bolds.push(content);
    return `\x00BD${idx}\x00`;
  });

  // 4. 提取 URL（保护不被转义）
  const urls: string[] = [];
  remaining = remaining.replace(/(https?:\/\/[^\s)>\]]+)/g, (url: string) => {
    const idx = urls.length;
    urls.push(url);
    return `\x00URL${idx}\x00`;
  });

  // 5. 转义剩余文本
  remaining = escapeMarkdownV2(remaining);

  // 6. 还原粗体
  remaining = remaining.replace(/\x00BD(\d+)\x00/g, (_, idx: string) => {
    return `*${escapeMarkdownV2(bolds[Number(idx)]!)}*`;
  });

  // 7. 还原行内代码（代码内不转义）
  remaining = remaining.replace(/\x00IC(\d+)\x00/g, (_, idx: string) => {
    return `\`${inlineCodes[Number(idx)]!}\``;
  });

  // 8. 还原代码块
  remaining = remaining.replace(/\x00CB(\d+)\x00/g, (_, idx: string) => {
    return `\`\`\`\n${codeBlocks[Number(idx)]!}\n\`\`\``;
  });

  // 9. 还原 URL（不转义）
  remaining = remaining.replace(/\x00URL(\d+)\x00/g, (_, idx: string) => {
    return urls[Number(idx)]!;
  });

  return remaining;
}
