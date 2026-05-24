// ────────────────────────────────────────
// Shared SSRF checks + pinned HTTP(S) fetch
// DNS is resolved once per request hop; connection uses that IP (mitigates rebinding).
// Redirects are followed manually with re-validation per hop.
// ────────────────────────────────────────

import * as http from 'node:http';
import * as https from 'node:https';
import { lookup } from 'dns/promises';
import { isIP } from 'node:net';

const BLOCKED_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^224\./,
  /^240\./,
  /^::1$/,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

/** Normalize IPv4-mapped IPv6 (::ffff:x.x.x.x) to dotted IPv4 for range checks */
export function normalizeIpForSsrf(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip.trim());
  if (m?.[1]) return m[1];
  return ip.trim();
}

export function isPrivateOrBlockedIp(ip: string): boolean {
  const n = normalizeIpForSsrf(ip);
  if (BLOCKED_RANGES.some((r) => r.test(n))) return true;
  const kind = isIP(n);
  if (kind === 4) {
    const parts = n.split('.').map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
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
    throw new Error('Only http(s) URLs are allowed');
  }
  const host = u.hostname;
  if (host === 'localhost' || host === '[::1]') {
    throw new Error('Blocked hostname');
  }
  const bare = host.replace(/^\[|\]$/g, '');
  const literalKind = isIP(bare);
  if (literalKind && isPrivateOrBlockedIp(bare)) {
    throw new Error('Blocked IP');
  }
}

/**
 * Resolve hostname; every address must be public. Returns one address to connect to.
 */
export async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const clean = hostname.replace(/^\[|\]$/g, '');
  const literalKind = isIP(clean);
  if (literalKind) {
    if (isPrivateOrBlockedIp(clean)) throw new Error('Blocked IP');
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
      throw new Error(`Blocked: ${hostname} resolves to private/disallowed IP ${address}`);
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

  const hostOpt = family === 6 ? `[${address}]` : address;

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
