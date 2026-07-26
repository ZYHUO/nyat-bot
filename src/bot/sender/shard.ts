// ────────────────────────────────────────
// MarkdownV2 分片 — 无依赖,可独立单测。
// ────────────────────────────────────────

/** Telegram 单条文本消息上限。 */
export const TG_TEXT_LIMIT = 4096;

/**
 * 按**转义后**长度把 MarkdownV2 文本切成 ≤4096 的片段。
 *
 * 为什么必须在这一层切:parser.truncateReply 截到**正好** 4096 个源字符,而
 * escapeMarkdownV2 给每个特殊字符加一个反斜杠 —— 实测 4093 个 'a' + '...' 转义后是 4099,
 * 纯中文 + 句号同样是 4099,特殊字符密集的英文/代码膨胀更多。而 segmenter 的长度闸有
 * `getWesternRatio < 0.1` 前置条件,英文/代码直接跳过,于是长回复原样单段送到这里 →
 * Telegram 400 "message is too long" → 三层 catch 都不匹配(只认 reply-not-found 与
 * parse 错误)→ 用户收到"喵呜...本喵出了点小故障"。
 *
 * 切点约束:
 *   - 不能落在 `\x` 转义对中间(会留下孤立反斜杠,下一片首字符被吞)
 *   - 不能把 ``` 代码块实体切开(Telegram 会报 can't parse entities)
 * 所以优先在换行/句末找切点,并且始终把切点推到转义对之外。
 */
export function shardMarkdownV2(md: string, limit = TG_TEXT_LIMIT): string[] {
  if (md.length <= limit) return [md];

  // 代码块内不切:先按 ``` 配对切出"可切/不可切"区段,不可切的整段作为一片(超限只能硬切)。
  const parts: string[] = [];
  let rest = md;

  while (rest.length > limit) {
    let cut = limit;

    // 若 limit 落在代码围栏内部,退到围栏开始处
    const fencesBefore = (rest.slice(0, cut).match(/```/g) ?? []).length;
    if (fencesBefore % 2 === 1) {
      const lastFence = rest.lastIndexOf('```', cut);
      if (lastFence > 0) cut = lastFence;
    }

    // 优先换行,其次句末标点,最后空格
    const window = rest.slice(0, cut);
    const nl = window.lastIndexOf('\n');
    const sentence = Math.max(
      window.lastIndexOf('。'), window.lastIndexOf('!'), window.lastIndexOf('?'),
      window.lastIndexOf('！'), window.lastIndexOf('？'), window.lastIndexOf('\n\n'),
    );
    const space = window.lastIndexOf(' ');
    for (const cand of [nl, sentence, space]) {
      if (cand > limit * 0.5) { cut = cand + 1; break; }
    }

    // 切点不能落在 `\x` 转义对中间:统计切点前连续反斜杠数,奇数则把切点回退一格。
    let bs = 0;
    while (cut - 1 - bs >= 0 && rest[cut - 1 - bs] === '\\') bs++;
    if (bs % 2 === 1) cut -= 1;

    if (cut <= 0) cut = limit; // 兜底:实在找不到安全切点就硬切
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}
