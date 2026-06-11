import { describe, it, expect } from 'vitest';
import { toMarkdownV2 } from '../../../src/bot/sender/markdown.js';

// #37 金样测试 —— MarkdownV2 转换出了名的难缠:每条出站消息都过这里,
// 转义错一处 Telegram 整条拒收(can't parse entities)→ 纯文本回退丢全部
// 格式。golden 先行,改造在后。

describe('toMarkdownV2 golden — plain text escaping', () => {
  it('escapes all MarkdownV2 specials in plain text', () => {
    expect(toMarkdownV2('hello. (world)! #tag a-b c+d e=f {x} |y| ~z~')).toBe(
      'hello\\. \\(world\\)\\! \\#tag a\\-b c\\+d e\\=f \\{x\\} \\|y\\| \\~z\\~',
    );
  });

  it('leaves CJK punctuation untouched', () => {
    expect(toMarkdownV2('你好。这样——很好!')).toBe('你好。这样——很好\\!');
  });

  it('passes whitespace-only input through unchanged', () => {
    expect(toMarkdownV2('   ')).toBe('   ');
    expect(toMarkdownV2('')).toBe('');
  });
});

describe('toMarkdownV2 golden — bold', () => {
  it('converts **bold** to *bold*', () => {
    expect(toMarkdownV2('**重点**注意.')).toBe('*重点*注意\\.');
  });

  it('escapes specials INSIDE bold content', () => {
    expect(toMarkdownV2('**a.b!**')).toBe('*a\\.b\\!*');
  });

  it('handles multiple bold spans', () => {
    expect(toMarkdownV2('**一** 和 **二**')).toBe('*一* 和 *二*');
  });
});

describe('toMarkdownV2 golden — code', () => {
  it('keeps benign inline-code content unescaped', () => {
    expect(toMarkdownV2('run `a.b()` ok')).toBe('run `a.b()` ok');
  });

  it('rewraps code blocks with newline padding', () => {
    expect(toMarkdownV2('```const x = 1;```')).toBe('```\nconst x = 1;\n```');
  });

  it('does not double-process bold markers inside code', () => {
    expect(toMarkdownV2('`**not bold**`')).toBe('`**not bold**`');
  });
});
