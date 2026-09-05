import { describe, expect, it } from 'vitest';

import { extractPixivId, parsePixivSearchResults, pixivSearchUrl, pixivThumbUrl } from '../../../../src/pipeline/tools/pixiv.js';

const SAMPLE = {
  error: false,
  body: {
    illustManga: {
      data: [
        {
          id: '123',
          title: '安全猫图',
          illustType: 0,
          xRestrict: 0,
          url: 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/01/01/00/00/00/123_p0_square1200.jpg',
          tags: ['cat', 'original'],
          userId: '42',
          userName: '画师A',
          width: 1200,
          height: 900,
          pageCount: 1,
          createDate: '2026-01-01T00:00:00+09:00',
        },
        {
          id: '124',
          title: '成人内容',
          xRestrict: 2,
          url: 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/01/01/00/00/00/124_p0_square1200.jpg',
          tags: ['R-18'],
          userId: '43',
          userName: '画师B',
        },
      ],
    },
  },
};

describe('pixiv tool helpers', () => {
  it('builds a public artwork search URL with encoded query', () => {
    const url = pixivSearchUrl('初音 未来', 2);
    expect(url).toContain('https://www.pixiv.net/ajax/search/artworks/');
    expect(url).toContain('%E5%88%9D%E9%9F%B3%20%E6%9C%AA%E6%9D%A5');
    expect(url).toContain('word=%E5%88%9D%E9%9F%B3+%E6%9C%AA%E6%9D%A5');
    expect(url).toContain('p=2');
  });

  it('parses public all-ages search results and filters adult works', () => {
    const rows = parsePixivSearchResults(JSON.stringify(SAMPLE), 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: '123',
      title: '安全猫图',
      userName: '画师A',
      pageCount: 1,
    });
    expect(rows[0]!.pageUrl).toBe('https://www.pixiv.net/artworks/123');
  });

  it('extracts pixiv id from raw id, artwork URL, or pximg URL', () => {
    expect(extractPixivId('123')).toBe('123');
    expect(extractPixivId('https://www.pixiv.net/artworks/123')).toBe('123');
    expect(extractPixivId('https://i.pximg.net/img-original/img/2026/01/01/00/00/00/123_p0.jpg')).toBe('123');
    expect(extractPixivId('https://example.com/123')).toBeNull();
  });

  it('converts square thumbnail URLs to the larger preview asset', () => {
    expect(pixivThumbUrl(SAMPLE.body.illustManga.data[0]!)).toBe(
      'https://i.pximg.net/c/540x540_70/img-master/img/2026/01/01/00/00/00/123_p0_master1200.jpg',
    );
  });
});
