// MarkdownV2 转换 — AI 输出纯文本/基础 Markdown，发送前转为 Telegram MarkdownV2

const SPECIAL_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

function escapeMarkdownV2(text: string): string {
  return text.replace(SPECIAL_CHARS, '\\$1');
}

/**
 * 将 AI 输出的文本转为 Telegram MarkdownV2 格式。
 * 支持：**粗体**、`行内代码`、```代码块```、裸 URL → 链接实体。
 * 其余特殊字符自动转义。
 */
export function toMarkdownV2(text: string): string {
  if (!text.trim()) return text;

  // \x00 是本函数内部的占位符定界符。入参自带它(模型复读上一轮的坏输出、或上游拼进
  // 来的脏数据)会让 `bolds[Number(idx)]` 取到 undefined,escapeMarkdownV2(undefined)
  // 直接抛 TypeError,异常穿过 withRetry 冒到 deliver 的兜底 catch。先无条件剥掉。
  let remaining = text.replace(/\x00/g, '');

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

  // 3.5 提取剧透 ||...||（Telegram 较新实体，点开才可见）。双竖线 bot 平时不用，
  // 冲突低；内容非空、不含竖线。用来藏结局/答案/梗，点开才见。
  const spoilers: string[] = [];
  remaining = remaining.replace(/\|\|([^|\n]+?)\|\|/g, (_, content: string) => {
    const idx = spoilers.length;
    spoilers.push(content);
    return `\x00SP${idx}\x00`;
  });

  // 4. 提取 URL → 还原时包成 [显示文本](href) 链接实体。
  // 裸 URL 在严格 MarkdownV2 下不合法:URL 里的 . = - + # 等全是必转义
  // 字符,原样保留必然 can't parse entities → 整条消息掉纯文本回退。
  // ')' 允许出现在 URL 内(维基风格 /wiki/Foo_(bar)),但句尾标点和未
  // 配平的右括号属于行文,循环剥离直到稳定。
  const urls: string[] = [];
  remaining = remaining.replace(/(https?:\/\/[^\s>\]]+)/g, (url: string) => {
    let u = url;
    let trimmed = '';
    for (;;) {
      const punct = u.match(/[.,;:!?。，！？；：…]+$/);
      if (punct) {
        u = u.slice(0, -punct[0].length);
        trimmed = punct[0] + trimmed;
        continue;
      }
      if (u.endsWith(')')) {
        const opens = (u.match(/\(/g) ?? []).length;
        const closes = (u.match(/\)/g) ?? []).length;
        if (closes > opens) {
          u = u.slice(0, -1);
          trimmed = ')' + trimmed;
          continue;
        }
      }
      break;
    }
    const idx = urls.length;
    urls.push(u);
    return `\x00URL${idx}\x00${trimmed}`;
  });

  // 5. 转义剩余文本
  remaining = escapeMarkdownV2(remaining);

  // 6. 还原剧透**先于**粗体:剧透正则 (步骤 3.5) 可能把粗体占位符 \x00BD{n}\x00 整体
  //    吞进 spoilers[] 里。若先还原粗体,那个占位符此刻还藏在数组里、匹配不到;等 6.5
  //    把剧透还原回文本时,BD 占位符被重新注入到**已经走过**粗体还原的文本上 —— 结果
  //    是粗体内容彻底丢失、群里出现裸 \x00 和字面量 "BD0",且因为 ||…|| 本身合法,
  //    Telegram 不报 can't parse entities,纯文本回退也不触发。
  //    (IC/CB/URL 的还原本来就排在剧透之后,所以只有粗体这一对顺序是错的。)
  remaining = remaining.replace(/\x00SP(\d+)\x00/g, (_, idx: string) => {
    return `||${escapeMarkdownV2(spoilers[Number(idx)]!)}||`;
  });

  // 6.5 还原粗体
  remaining = remaining.replace(/\x00BD(\d+)\x00/g, (_, idx: string) => {
    return `*${escapeMarkdownV2(bolds[Number(idx)]!)}*`;
  });

  // 7. 还原行内代码。code 实体内规范要求 '\' 和 '`' 必须转义
  //   (捕获正则已排除内容含反引号,这里实际只有 '\' 会命中)。
  remaining = remaining.replace(/\x00IC(\d+)\x00/g, (_, idx: string) => {
    return `\`${inlineCodes[Number(idx)]!.replace(/([\\`])/g, '\\$1')}\``;
  });

  // 8. 还原代码块。pre 实体内同样转义 '\' 和 '`'。
  remaining = remaining.replace(/\x00CB(\d+)\x00/g, (_, idx: string) => {
    return `\`\`\`\n${codeBlocks[Number(idx)]!.replace(/([\\`])/g, '\\$1')}\n\`\`\``;
  });

  // 9. 还原 URL:[转义后的显示文本](转义后的 href)。
  //   显示文本按普通规则全量转义;(...) 内规范只要求转义 ')' 和 '\'。
  remaining = remaining.replace(/\x00URL(\d+)\x00/g, (_, idx: string) => {
    const url = urls[Number(idx)]!;
    const href = url.replace(/([\\)])/g, '\\$1');
    return `[${escapeMarkdownV2(url)}](${href})`;
  });

  return remaining;
}
