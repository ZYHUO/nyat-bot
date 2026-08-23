import { describe, it, expect, vi, beforeEach } from 'vitest';

// artist 的行为源：LLM 调用（ai/fallback）与沙盒写文件（sandbox/files）。
// 直接 mock 这两个模块；sharp 光栅化走真的——SVG 能不能渲染正是要验证的点。

const callWithFallbackMock = vi.fn();
vi.mock('../../../src/ai/fallback.js', () => ({
  callWithFallback: (...args: unknown[]) => callWithFallbackMock(...args),
}));

const writeFileMock = vi.fn(async (path: string) => ({ ok: true, path }));
const writeBinaryMock = vi.fn(async (path: string) => ({ ok: true, path }));
vi.mock('../../../src/sandbox/files.js', () => ({
  sandboxWriteFile: (path: string, content: string) => writeFileMock(path, content),
  sandboxWriteBinary: (path: string, buf: Uint8Array) => writeBinaryMock(path, buf),
}));

vi.mock('../../../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const GOOD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#FFF0F5"/><stop offset="1" stop-color="#FFC2D4"/>
  </linearGradient></defs>
  <rect width="1024" height="1024" rx="48" fill="url(#bg)"/>
  <circle cx="512" cy="460" r="180" fill="#FFFFFF" stroke="#6D3B47" stroke-width="8"/>
  <text x="512" y="900" font-size="64" text-anchor="middle" fill="#6D3B47"
    font-family="'Noto Sans CJK SC',sans-serif">测试券</text>
</svg>`;

async function importArtist() {
  return await import('../../../src/agent/artist.js');
}

describe('artist 画摊子', () => {
  beforeEach(() => {
    callWithFallbackMock.mockReset();
    writeFileMock.mockClear();
    writeBinaryMock.mockClear();
  });

  describe('extractSvg', () => {
    it('从 ```svg 围栏提取', async () => {
      const { extractSvg } = await importArtist();
      expect(extractSvg(`好的\n\`\`\`svg\n${GOOD_SVG}\n\`\`\``)).toBe(GOOD_SVG);
    });
    it('无围栏时取 <svg> 到 </svg> 区间', async () => {
      const { extractSvg } = await importArtist();
      expect(extractSvg(`前言${GOOD_SVG}后记`)).toBe(GOOD_SVG);
    });
    it('没有 SVG → null', async () => {
      const { extractSvg } = await importArtist();
      expect(extractSvg('我不会画画')).toBeNull();
    });
  });

  describe('sanitizeSvg', () => {
    it('合法 SVG 原样通过', async () => {
      const { sanitizeSvg } = await importArtist();
      expect(sanitizeSvg(GOOD_SVG)).toBe(GOOD_SVG);
    });
    it('缺 xmlns 自动补（librsvg 没它不渲染）', async () => {
      const { sanitizeSvg } = await importArtist();
      const out = sanitizeSvg(GOOD_SVG.replace(' xmlns="http://www.w3.org/2000/svg"', ''));
      expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    });
    it('script / foreignObject / image / href / animate 一律拒', async () => {
      const { sanitizeSvg } = await importArtist();
      const inject = (s: string) => GOOD_SVG.replace('</svg>', `${s}</svg>`);
      expect(sanitizeSvg(inject('<script>alert(1)</script>'))).toBeNull();
      expect(sanitizeSvg(inject('<foreignObject><div>x</div></foreignObject>'))).toBeNull();
      expect(sanitizeSvg(inject('<image href="http://evil/x.png"/>'))).toBeNull();
      expect(sanitizeSvg(inject('<animate attributeName="x"/>'))).toBeNull();
    });
    it('XML 不合法 → null', async () => {
      const { sanitizeSvg } = await importArtist();
      expect(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>')).toBeNull();
    });
  });

  describe('drawArtwork', () => {
    it('一轮出稿：返回沙盒路径 + 真实光栅化的 PNG', async () => {
      callWithFallbackMock.mockResolvedValue({ content: `\`\`\`svg\n${GOOD_SVG}\n\`\`\`` });
      const { drawArtwork } = await importArtist();
      const r = await drawArtwork('画一张测试券');
      expect('error' in r).toBe(false);
      if ('error' in r) return;
      expect(r.pngPath).toMatch(/^art\/.+\.png$/);
      expect(r.svgPath).toMatch(/^art\/.+\.svg$/);
      // density 144 → 1024 * 2 = 2048px
      expect(r.width).toBe(2048);
      expect(r.height).toBe(2048);
      // 写出去的真是 PNG（magic bytes），SVG 文本也落了
      const png = writeBinaryMock.mock.calls[0]![1] as Buffer;
      expect(png[0]).toBe(0x89);
      expect(png.toString('latin1', 1, 4)).toBe('PNG');
      expect(String(writeFileMock.mock.calls[0]![1])).toContain('<svg');
      expect(callWithFallbackMock).toHaveBeenCalledTimes(1);
    });

    it('首轮废稿 → 修复轮救回（错误反馈进 messages）', async () => {
      callWithFallbackMock
        .mockResolvedValueOnce({ content: '我不会画画，给你文字吧' })
        .mockResolvedValueOnce({ content: GOOD_SVG });
      const { drawArtwork } = await importArtist();
      const r = await drawArtwork('画一张测试券');
      expect('error' in r).toBe(false);
      expect(callWithFallbackMock).toHaveBeenCalledTimes(2);
      const secondCall = callWithFallbackMock.mock.calls[1]![0] as {
        messages: Array<{ role: string; content: string }>;
      };
      const repairMsg = secondCall.messages.find((m) => m.content.includes('上一稿废了'));
      expect(repairMsg).toBeTruthy();
    });

    it('两轮都废 → {error}，不炸调用方', async () => {
      callWithFallbackMock.mockResolvedValue({ content: '就是画不出来' });
      const { drawArtwork } = await importArtist();
      const r = await drawArtwork('画一张测试券');
      expect('error' in r).toBe(true);
      if ('error' in r) expect(r.error).toBe('no_svg_in_output');
    });

    it('空描述直接拒', async () => {
      const { drawArtwork } = await importArtist();
      const r = await drawArtwork('   ');
      expect('error' in r).toBe(true);
      expect(callWithFallbackMock).not.toHaveBeenCalled();
    });
  });
});
