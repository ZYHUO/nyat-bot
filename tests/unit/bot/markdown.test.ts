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

describe('toMarkdownV2 — URL link entities (#37)', () => {
  it('wraps a bare URL as a valid link entity (display escaped, href raw)', () => {
    expect(toMarkdownV2('see https://example.com/page now')).toBe(
      'see [https://example\\.com/page](https://example.com/page) now',
    );
  });

  it('Wikipedia-style URL keeps balanced parens; href escapes only ) and \\', () => {
    expect(toMarkdownV2('https://en.wikipedia.org/wiki/Foo_(bar) now')).toBe(
      '[https://en\\.wikipedia\\.org/wiki/Foo\\_\\(bar\\)](https://en.wikipedia.org/wiki/Foo_(bar\\)) now',
    );
  });

  it('prose-closing paren is NOT swallowed into the URL', () => {
    expect(toMarkdownV2('(see https://x.com/a)')).toBe(
      '\\(see [https://x\\.com/a](https://x.com/a)\\)',
    );
  });

  it('snake_case URL no longer leaks raw underscores', () => {
    expect(toMarkdownV2('https://x.com/a_b_c in text')).toBe(
      '[https://x\\.com/a\\_b\\_c](https://x.com/a_b_c) in text',
    );
  });

  it('trailing sentence punctuation stays out of the link target', () => {
    expect(toMarkdownV2('看这个 https://example.com/page。')).toBe(
      '看这个 [https://example\\.com/page](https://example.com/page)。',
    );
    expect(toMarkdownV2('go to https://example.com/page.')).toBe(
      'go to [https://example\\.com/page](https://example.com/page)\\.',
    );
  });

  it('URL with query string produces a fully-escaped display text', () => {
    expect(toMarkdownV2('https://e.com/a?b=1&c=2 ok')).toBe(
      '[https://e\\.com/a?b\\=1&c\\=2](https://e.com/a?b=1&c=2) ok',
    );
  });
});

describe('toMarkdownV2 — code-entity escaping (#37)', () => {
  it('escapes backslashes inside inline code', () => {
    expect(toMarkdownV2('path `C:\\tmp\\x` ok')).toBe('path `C:\\\\tmp\\\\x` ok');
  });

  it('escapes backticks and backslashes inside code blocks', () => {
    expect(toMarkdownV2('```a `b` c\\d```')).toBe('```\na \\`b\\` c\\\\d\n```');
  });
});

describe('toMarkdownV2 — spoiler ||...||（Telegram 较新实体）', () => {
  it('包成剧透实体', () => {
    expect(toMarkdownV2('答案是||42||喵')).toBe('答案是||42||喵');
  });
  it('剧透内容里的特殊字符照常转义', () => {
    expect(toMarkdownV2('||a.b-c||')).toBe('||a\\.b\\-c||');
  });
  it('单竖线不当剧透(仍转义)', () => {
    expect(toMarkdownV2('|y|')).toBe('\\|y\\|');
  });
  it('空剧透不匹配(|| || 里必须有内容)', () => {
    expect(toMarkdownV2('||||')).toBe('\\|\\|\\|\\|');
  });
  it('粗体与剧透并存', () => {
    expect(toMarkdownV2('**重点**：结局||他领便当||')).toBe('*重点*：结局||他领便当||');
  });
  it('剧透不跨行', () => {
    expect(toMarkdownV2('||第一行\n第二行||')).toBe('\\|\\|第一行\n第二行\\|\\|');
  });
});
