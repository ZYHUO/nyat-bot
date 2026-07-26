// ────────────────────────────────────────
// Shared SSRF checks + pinned HTTP(S) fetch
// DNS is resolved once per request hop; connection uses that IP (mitigates rebinding).
// Redirects are followed manually with re-validation per hop.
// ────────────────────────────────────────

import * as http from 'node:http';
import * as https from 'node:https';
import { lookup } from 'dns/promises';
import { isIP } from 'node:net';
import { logger } from '../../shared/logger.js';

/**
 * SSRF 守卫被触发时抛这个,而不是普通 Error —— 调用方(web-fetch.executeFetch)必须能把
 * "守卫拒绝" 与 "目标不可达" 区分开。原先两者都是 Error,catch 里第一动作是把同一个已判禁
 * 的 URL 交给 tryCfFallback(本机无头浏览器,零校验),等于守卫判定被降级成了一次重试。
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/** 允许的目标端口(空 port = 协议默认 80/443,单独放行)。 */
const ALLOWED_PORTS = new Set(['80', '443', '8080', '8443']);

/**
 * 把 IP 字符串解析成字节数组。IPv6 走手工展开(::、嵌尾 IPv4 都处理),这样范围判断可以在
 * **字节**上做,而不是在字符串形态上做正则匹配。
 *
 * 原实现的问题:normalizeIpForSsrf 的正则要求点分十进制(`::ffff:127.0.0.1`),而 WHATWG URL
 * **总是**把 IPv4-mapped 序列化成十六进制(`[::ffff:7f00:1]`),所以那个正则永远匹配不到 ——
 * 整个 IPv4-mapped 防护是死代码。实测放行清单:[::ffff:127.0.0.1]、[::ffff:169.254.169.254]、
 * [::]、[fc00::1](`^fd[0-9a-f]{2}:` 只盖了 ULA 的一半)。
 */
function ipToBytes(ip: string): number[] | null {
  const s = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // 去掉方括号与 zone id
  const kind = isIP(s);
  if (kind === 4) return s.split('.').map(Number);
  if (kind !== 6) return null;

  // 嵌尾 IPv4:`::ffff:127.0.0.1` / `64:ff9b::192.0.2.1`
  let head = s;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const afterLastColon = s.slice(lastColon + 1);
  if (afterLastColon.includes('.')) {
    if (isIP(afterLastColon) !== 4) return null;
    tail = afterLastColon.split('.').map(Number);
    head = s.slice(0, lastColon + 1);
  }

  const [left, right] = head.includes('::') ? head.split('::') : [head, undefined];
  const parseGroups = (part: string | undefined): number[] => {
    if (!part) return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (g === '') continue;
      const v = Number.parseInt(g, 16);
      if (!Number.isFinite(v) || v < 0 || v > 0xffff) return [];
      out.push((v >> 8) & 0xff, v & 0xff);
    }
    return out;
  };
  const lhs = parseGroups(left);
  const rhs = parseGroups(right);
  const known = lhs.length + rhs.length + tail.length;
  if (known > 16) return null;
  const zeros = new Array<number>(16 - known).fill(0);
  const bytes = right === undefined && tail.length === 0
    ? lhs
    : [...lhs, ...zeros, ...rhs, ...tail];
  return bytes.length === 16 ? bytes : null;
}

function isBlockedV4(b: number[]): boolean {
  const [a = 0, c = 0] = b;
  if (a === 0) return true;                                   // 0.0.0.0/8 (含 0.0.0.0)
  if (a === 10) return true;                                  // RFC1918
  if (a === 127) return true;                                 // loopback
  if (a === 169 && c === 254) return true;                    // link-local + 云 IMDS
  if (a === 172 && c >= 16 && c <= 31) return true;           // RFC1918
  if (a === 192 && c === 168) return true;                    // RFC1918
  if (a === 100 && c >= 64 && c <= 127) return true;          // CGNAT 100.64/10
  if (a === 192 && c === 0 && (b[2] === 0 || b[2] === 2)) return true; // 192.0.0/24, TEST-NET-1
  if (a === 198 && (c === 18 || c === 19)) return true;        // 198.18/15 benchmark
  if (a === 198 && c === 51 && b[2] === 100) return true;      // TEST-NET-2
  if (a === 203 && c === 0 && b[2] === 113) return true;       // TEST-NET-3
  if (a >= 224) return true;                                   // multicast + 240/4 + 255.255.255.255
  return false;
}

export function isPrivateOrBlockedIp(ip: string): boolean {
  const b = ipToBytes(ip);
  if (!b) return false; // 不是 IP 字面量 → 由 resolvePublicAddress 解析后再判
  if (b.length === 4) return isBlockedV4(b);

  // ::ffff:0:0/96 (IPv4-mapped) 与 64:ff9b::/96 (NAT64) → 取低 32 位当 IPv4 递归判定。
  const isV4Mapped =
    b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  const isNat64 =
    b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0);
  if (isV4Mapped || isNat64) return isBlockedV4(b.slice(12, 16));

  if (b.every((x) => x === 0)) return true;                        // :: (unspecified)
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1 loopback
  if (((b[0] ?? 0) & 0xfe) === 0xfc) return true;                  // fc00::/7 (ULA 全段)
  if ((b[0] ?? 0) === 0xfe && (((b[1] ?? 0) & 0xc0) === 0x80)) return true; // fe80::/10 link-local
  if ((b[0] ?? 0) === 0xff) return true;                           // ff00::/8 multicast
  return false;
}

export function assertUrlSsrfSafe(urlStr: string): void {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error('Invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfBlockedError('Only http(s) URLs are allowed');
  }
  const host = u.hostname;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]') {
    throw new SsrfBlockedError('Blocked hostname');
  }
  // 端口白名单:内网服务大多不在 80/443 上(Qdrant 6333、Redis 6379、本机 fetch 服务 8900…),
  // 限制端口把"即使某个 IP 判定被绕过也打不到有意思的东西"变成第二道闸。
  if (u.port && !ALLOWED_PORTS.has(u.port)) {
    throw new SsrfBlockedError(`Blocked port ${u.port}`);
  }
  const bare = host.replace(/^\[|\]$/g, '');
  const literalKind = isIP(bare);
  if (literalKind && isPrivateOrBlockedIp(bare)) {
    throw new SsrfBlockedError('Blocked IP');
  }
}

/**
 * Resolve hostname; every address must be public. Returns one address to connect to.
 */
export async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const clean = hostname.replace(/^\[|\]$/g, '');
  const literalKind = isIP(clean);
  if (literalKind) {
    if (isPrivateOrBlockedIp(clean)) throw new SsrfBlockedError('Blocked IP');
    return { address: clean, family: literalKind === 4 ? 4 : 6 };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('DNS resolution failed');
  }
  if (!addresses.length) throw new Error('DNS returned no addresses');

  for (const { address } of addresses) {
    if (isPrivateOrBlockedIp(address)) {
      // 不要把解析出来的内网 IP 放进 message —— 这个 message 会被 executeFetch 当工具结果
      // 回给模型并复述给用户,等于把 FETCH 变成内网 DNS 枚举探针(逐个域名试即可刷出内网
      // 网段拓扑,并区分主机存在/不存在)。详细信息只进 logger。
      logger.warn({ hostname, address }, 'SSRF guard: host resolves to private/disallowed IP');
      throw new SsrfBlockedError('Blocked: host resolves to a private/disallowed address');
    }
  }

  const v4 = addresses.find((a) => a.family === 4);
  const pick = v4 ?? addresses[0];
  if (!pick) throw new Error('No usable address');
  return { address: pick.address, family: pick.family === 6 ? 6 : 4 };
}

const MAX_REDIRECTS = 8;

/** RFC 7230 Host header — bracket IPv6 literals when needed */
function hostHeaderFromUrl(u: URL): string {
  const h = u.hostname;
  const v6 = isIP(h.replace(/^\[|\]$/g, '')) === 6;
  const bare = h.replace(/^\[|\]$/g, '');
  const hostPart = v6 ? `[${bare}]` : h;
  return u.port ? `${hostPart}:${u.port}` : hostPart;
}

export interface PinnedFetchResult {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  finalUrl: string;
}

/**
 * HTTP(S) with TLS SNI = original hostname, TCP to resolved public IP.
 */
export async function fetchUrlPinned(
  initialUrl: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
): Promise<PinnedFetchResult> {
  let method = options.method ?? 'GET';
  let reqBody = options.body;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBytes = options.maxBytes ?? 512 * 1024;
  let current = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertUrlSsrfSafe(current);
    const u = new URL(current);
    const { address, family } = await resolvePublicAddress(u.hostname);
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    const path = u.pathname + u.search;
    const hostHeader = hostHeaderFromUrl(u);

    const headers: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(options.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'host'),
      ),
      'User-Agent': options.headers?.['User-Agent'] ?? options.headers?.['user-agent'] ?? 'XXB-WebFetch/1.0',
      Host: hostHeader,
    };

    const res = await requestOnce({
      protocol: u.protocol,
      hostnameForSni: u.hostname,
      address,
      family,
      port,
      path,
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : reqBody,
      signal: options.signal,
      timeoutMs,
      maxBytes,
    });

    const code = res.statusCode ?? 0;
    if (code >= 300 && code < 400) {
      const loc = res.headers.location;
      const next = typeof loc === 'string' ? loc : Array.isArray(loc) ? loc[0] : undefined;
      if (!next) {
        return { statusCode: code, headers: res.headers, body: res.text, finalUrl: current };
      }
      current = new URL(next, current).href;
      method = 'GET';
      reqBody = undefined;
      continue;
    }

    return { statusCode: code, headers: res.headers, body: res.text, finalUrl: current };
  }

  throw new Error('Too many redirects');
}

interface RequestOnceResult {
  statusCode?: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function requestOnce(opts: {
  protocol: string;
  hostnameForSni: string;
  address: string;
  family: 4 | 6;
  port: number;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
}): Promise<RequestOnceResult> {
  const {
    protocol,
    hostnameForSni,
    address,
    family,
    port,
    path,
    method,
    headers,
    body,
    signal,
    timeoutMs,
    maxBytes,
  } = opts;

  // http.request 的 `hostname` 要**裸**地址:带方括号时 Node 不剥括号,而是把
  // "[::1]" 当 DNS 名去 getaddrinfo → ENOTFOUND。方括号只属于 Host 头
  // (hostHeaderFromUrl 已经处理)。原先带括号使 fetchUrlPinned 连不上任何 IPv6 地址 ——
  // 这偶然缓解了 IPv6 判定的缺口,但一旦"顺手修好"就变成直连内网,所以这两处必须一起改。
  const hostOpt = address;

  return new Promise((resolve, reject) => {
    const lib = protocol === 'https:' ? https : http;
    // Assigned after onAbort is declared so abort can destroy the active request.
    // eslint-disable-next-line prefer-const
    let req!: http.ClientRequest;
    const onAbort = () => {
      req.destroy(new Error('Aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req = lib.request(
      {
        hostname: hostOpt,
        port,
        path,
        method,
        headers,
        ...(protocol === 'https:' ? { servername: hostnameForSni, rejectUnauthorized: true } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          const room = maxBytes - total;
          if (room <= 0) return;
          if (chunk.length <= room) {
            chunks.push(chunk);
            total += chunk.length;
          } else {
            chunks.push(chunk.subarray(0, room));
            total = maxBytes;
            res.destroy();
          }
        });
        res.on('end', () => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (err) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Timeout'));
    });
    req.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
      const buf = Buffer.from(body, 'utf8');
      req.setHeader('Content-Length', buf.length);
      req.write(buf);
    }
    req.end();
  });
}
