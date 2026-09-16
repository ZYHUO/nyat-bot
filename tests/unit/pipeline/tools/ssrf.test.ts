// ────────────────────────────────────────
// SSRF 守卫的真实断言矩阵。
//
// 之前这个文件不存在,而 web-fetch.test.ts 把 ssrf.js 整体 mock 成
// `assertUrlSsrfSafe: vi.fn()`(无条件通过)—— 所以守卫的实际行为零覆盖。
// 曾因此长期漏掉:IPv4-mapped IPv6 全线放行(normalizeIpForSsrf 的正则匹配不到 WHATWG URL
// 产出的十六进制形态,整段是死代码)、fc00::/8 未覆盖(只写了 fd00::/8)、`::` 放行、
// 无端口限制。
//
// 注意十进制/八进制/十六进制 IPv4(2130706433 / 0177.0.0.1 / 0x7f000001)之所以被挡,
// 靠的是 WHATWG URL 会把它们归一化成 127.0.0.1 —— 不是 BLOCKED_RANGES 的功劳。这里
// 一并断言,免得将来有人"优化"掉解析步骤。
// ────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  assertUrlSsrfSafe,
  isPrivateOrBlockedIp,
  SsrfBlockedError,
} from '../../../../src/pipeline/tools/ssrf.js';

const MUST_BLOCK: Array<[string, string]> = [
  ['http://127.0.0.1/', 'loopback v4'],
  ['http://[::1]/', 'loopback v6'],
  ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback (URL serialises to [::ffff:7f00:1])'],
  ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped cloud IMDS'],
  ['http://[64:ff9b::127.0.0.1]/', 'NAT64-wrapped loopback'],
  ['http://[::]/', 'unspecified v6'],
  ['http://[fc00::1]/', 'ULA fc00::/8 half'],
  ['http://[fd00::1]/', 'ULA fd00::/8 half'],
  ['http://[fe80::1]/', 'link-local v6'],
  ['http://[ff02::1]/', 'multicast v6'],
  ['http://2130706433/', 'decimal IPv4 (normalised by URL parser)'],
  ['http://0177.0.0.1/', 'octal IPv4'],
  ['http://0x7f000001/', 'hex IPv4'],
  ['http://169.254.169.254/', 'cloud IMDS'],
  ['http://10.0.0.1/', 'RFC1918 10/8'],
  ['http://172.16.0.1/', 'RFC1918 172.16/12'],
  ['http://192.168.1.1/', 'RFC1918 192.168/16'],
  ['http://100.64.0.1/', 'CGNAT'],
  ['http://192.0.0.1/', '192.0.0.0/24'],
  ['http://198.18.0.1/', '198.18.0.0/15 benchmark'],
  ['http://255.255.255.255/', 'broadcast'],
  ['http://0.0.0.0/', 'unspecified v4'],
  ['http://localhost/', 'localhost'],
  ['http://foo.localhost/', '.localhost suffix'],
  ['http://example.com:6333/', 'Qdrant port'],
  ['http://example.com:6379/', 'Redis port'],
  ['http://example.com:8900/', 'local cf-fetch service port'],
  ['ftp://example.com/', 'non-http scheme'],
  ['file:///etc/passwd', 'file scheme'],
];

const MUST_ALLOW = [
  'http://example.com/',
  'https://example.com/',
  'https://example.com:443/',
  'http://example.com:8080/',
  'http://8.8.8.8/',
  'http://[2001:4860:4860::8888]/',
  'https://api.telegram.org/bot123/getMe',
];

describe('assertUrlSsrfSafe', () => {
  it.each(MUST_BLOCK)('blocks %s — %s', (url) => {
    expect(() => assertUrlSsrfSafe(url)).toThrow(SsrfBlockedError);
  });

  it.each(MUST_ALLOW)('allows %s', (url) => {
    expect(() => assertUrlSsrfSafe(url)).not.toThrow();
  });

  it('throws SsrfBlockedError (not bare Error) so callers can skip the fallback chain', () => {
    // executeFetch 的 catch 会对普通 Error 走 tryCfFallback(本机无头浏览器,零校验)。
    // 守卫判定必须能被区分出来,否则等于守卫被降级成一次重试。
    let caught: unknown;
    try {
      assertUrlSsrfSafe('http://169.254.169.254/');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SsrfBlockedError);
  });

  it('does not leak the resolved internal address in the error message', () => {
    // 这个 message 会作为工具结果回给模型并被复述给用户 —— 带上内网 IP 就把 FETCH
    // 变成了内网 DNS 枚举探针。
    expect(() => assertUrlSsrfSafe('http://10.1.2.3/')).toThrow(/^Blocked IP$/);
  });
});

describe('isPrivateOrBlockedIp', () => {
  it.each([
    ['::ffff:7f00:1', true, 'hex IPv4-mapped loopback — the form URL actually produces'],
    ['::ffff:127.0.0.1', true, 'dotted IPv4-mapped loopback'],
    ['fc00::1', true, 'ULA lower half'],
    ['fd00::1', true, 'ULA upper half'],
    ['::', true, 'unspecified'],
    ['::1', true, 'loopback'],
    ['2001:4860:4860::8888', false, 'public v6'],
    ['8.8.8.8', false, 'public v4'],
  ])('%s → %s (%s)', (ip, expected) => {
    expect(isPrivateOrBlockedIp(ip as string)).toBe(expected);
  });

  it('returns false for non-IP input (hostnames are judged after DNS resolution)', () => {
    expect(isPrivateOrBlockedIp('example.com')).toBe(false);
  });
});
