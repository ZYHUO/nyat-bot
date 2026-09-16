import { describe, it, expect } from 'vitest';
import { shardMarkdownV2, TG_TEXT_LIMIT } from '../../../src/bot/sender/shard.js';
import { toMarkdownV2 } from '../../../src/bot/sender/markdown.js';

// 发送层此前完全没有长度检查:parser.truncateReply 截到**正好** 4096 个源字符,而
// escapeMarkdownV2 每个特殊字符 +1 —— 实测 4093 个 'a' + '...' 转义后 4099,纯中文同样
// 4099。segmenter 的长度闸又有 `getWesternRatio < 0.1` 前置条件,英文/代码直接跳过。
// 于是 Telegram 400 "message is too long",三层 catch 都不匹配,用户只收到故障文案。

const CASES: Array<[string, string]> = [
  ['short ascii', 'hello world.'],
  ['exactly-4096 source chars (ascii)', 'a'.repeat(4093) + '...'],
  ['exactly-4096 source chars (cjk)', '喵'.repeat(4093) + '...'],
  ['escape-dense', '...!!!___***'.repeat(500)],
  ['long english prose', 'The quick brown fox jumps over the lazy dog. '.repeat(300)],
  ['long with newlines', 'line of text here\n'.repeat(600)],
  ['code block spanning the limit', '```\n' + 'const x = 1;\n'.repeat(600) + '```'],
  ['no separators at all', 'x'.repeat(12000)],
  ['mixed cjk + inline code', '喵喵喵。`code`\n'.repeat(500)],
  ['url heavy', 'see https://example.com/a/b?c=d&e=f '.repeat(400)],
];

describe('shardMarkdownV2', () => {
  it.each(CASES)('%s: every shard fits the Telegram limit', (_name, src) => {
    for (const shard of shardMarkdownV2(toMarkdownV2(src))) {
      expect(shard.length).toBeLessThanOrEqual(TG_TEXT_LIMIT);
    }
  });

  it.each(CASES)('%s: rejoining the shards is lossless', (_name, src) => {
    const md = toMarkdownV2(src);
    expect(shardMarkdownV2(md).join('')).toBe(md);
  });

  it.each(CASES)('%s: never splits a backslash escape pair', (_name, src) => {
    // 切点落在 `\x` 中间会留下孤立反斜杠,下一片的首字符被当成被转义字符吞掉。
    for (const shard of shardMarkdownV2(toMarkdownV2(src))) {
      const trailing = shard.match(/\\+$/);
      if (trailing) expect(trailing[0].length % 2).toBe(0);
    }
  });

  it('leaves short text as a single shard (no behaviour change on the common path)', () => {
    const md = toMarkdownV2('喵~ 今天天气不错');
    expect(shardMarkdownV2(md)).toEqual([md]);
  });

  it('prefers a newline boundary over a hard cut', () => {
    const md = 'a'.repeat(4000) + '\n' + 'b'.repeat(500);
    const shards = shardMarkdownV2(md, 4096);
    expect(shards[0]!.endsWith('\n')).toBe(true);
    expect(shards[1]!.startsWith('b')).toBe(true);
  });
});
