import { describe, it, expect } from 'vitest';
import { ensureHtmlCharset } from '../../../src/sandbox/files.js';

describe('ensureHtmlCharset', () => {
  it('无 charset 且带 <head> → 注入到 <head> 后', () => {
    const html = '<!DOCTYPE html>\n<html>\n<head>\n  <title>喵</title>\n</head>\n<body>hi</body>\n</html>';
    const out = ensureHtmlCharset(html);
    expect(out).toContain('<head>\n  <meta charset="UTF-8">\n  <title>喵</title>');
    expect(out).toContain('<title>喵</title>');
  });

  it('已有 charset(任意写法)→ 原样不动', () => {
    const html = '<html><head><meta charset="utf-8"><title>x</title></head><body></body></html>';
    expect(ensureHtmlCharset(html)).toBe(html);
    const html2 = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head></html>';
    expect(ensureHtmlCharset(html2)).toBe(html2);
    const html3 = '<html><head><meta charset=\'gb2312\'></head></html>';
    expect(ensureHtmlCharset(html3)).toBe(html3);
  });

  it('无 <head> 但有 <html> → 注入到 <html> 后', () => {
    const html = '<html><body>中文</body></html>';
    const out = ensureHtmlCharset(html);
    expect(out).toContain('<html>\n  <meta charset="UTF-8">');
    expect(out).toContain('<body>中文</body>');
  });

  it('完全不像 HTML(片段/纯文本)→ 不注入,原样返回', () => {
    const text = 'hello world';
    expect(ensureHtmlCharset(text)).toBe(text);
    const fragment = '<div>只是片段</div>';
    expect(ensureHtmlCharset(fragment)).toBe(fragment);
  });

  it('幂等:注入结果再注入一次不变', () => {
    const html = '<html><head><title>喵</title></head><body></body></html>';
    const once = ensureHtmlCharset(html);
    const twice = ensureHtmlCharset(once);
    expect(twice).toBe(once);
  });
});
