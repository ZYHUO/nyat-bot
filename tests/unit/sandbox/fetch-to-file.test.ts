/**
 * web.fetchToFile —— 沙盒不联网，数据由宿主侧带进来。
 *
 * 这条通道存在的前提是：**网络始终在宿主侧、受 SSRF 守卫约束，沙盒内没有任何出口**。
 * 所以最该锁的不是"能抓到"，而是"没有绕过守卫"。这里 SSRF 判定走**真实代码**
 * （assertUrlSsrfSafe / resolvePublicAddress / fetchUrlPinned 都不 mock），
 * 只把最底层的 node:http(s) 出站和 DNS 换成可控的假实现：
 *   ① 私网/loopback/云元数据 IP 被拦，且**连出站都没发生**
 *   ② 非白名单端口（Redis 6379 / Qdrant 6333）被拦，出站没发生
 *   ③ DNS 解析到私网地址被拦（rebinding 形状）
 *   ④ 非文本 content-type 不写文件；没有 content-type 也不写
 *   ⑤ 超过体积上限被截断，且返回值明说 truncated
 *   ⑥ 路径逃逸（../）被拒，且**没有文件落在沙盒外**
 *   ⑦ 正常 RSS → 文件内容与抓到的一致
 *   ⑧ 失败原因不回显内网细节（会被当成内网探针）
 *   ⑨ flag 默认关；关着时 host-api 不抓
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { buildCodeActSystemPrompt } from '../../../src/subagent/capability-prompt.js';
import { CODEACT_CAPABILITY_METHODS, selectCodeActCapabilities } from '../../../src/sandbox/codeact/capabilities.js';

let sandboxRoot = '';
vi.mock('../../../src/sandbox/paths.js', async () => {
  const { resolve, relative, isAbsolute } = await import('node:path');
  return {
    sandboxEnabled: () => true,
    resolveSandboxRoot: () => sandboxRoot,
    resolveInsideSandbox: (rel: string) => {
      const target = isAbsolute(rel) ? resolve(rel) : resolve(sandboxRoot, rel);
      const r = relative(sandboxRoot, target);
      if (r.startsWith('..') || isAbsolute(r)) throw new Error(`path_escape: ${rel} resolves outside sandbox`);
      return target;
    },
  };
});
vi.mock('../../../src/shared/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── 可控的 DNS ──
const dnsTable = new Map<string, string[]>();
vi.mock('dns/promises', () => ({
  lookup: async (host: string) => {
    const addrs = dnsTable.get(host);
    if (!addrs) throw new Error('ENOTFOUND');
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
}));

// ── 可控的出站：记录每一次真的发出去的请求 ──
type Reply = { status: number; headers: Record<string, string>; body: string; dropMidway?: boolean };
let nextReply: Reply = { status: 200, headers: { 'content-type': 'text/xml' }, body: '' };
const outbound: Array<{ host: string; port: number; path: string }> = [];

function fakeRequest(opts: Record<string, unknown>, cb: (res: unknown) => void): EventEmitter & { end: () => void; destroy: () => void; setTimeout: () => void } {
  const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void; setTimeout: () => void; write: () => void };
  outbound.push({ host: String(opts.hostname), port: Number(opts.port), path: String(opts.path) });
  req.write = () => {};
  req.setTimeout = () => {};
  req.destroy = () => {};
  req.end = () => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; setEncoding: () => void; resume: () => void };
    res.statusCode = nextReply.status;
    res.headers = nextReply.headers;
    res.setEncoding = () => {};
    res.resume = () => {};
    // 真实 Node：res.destroy() 之后只发 aborted + close，**不发 end 也不发 error**（已用真实 http 实测）。
    let destroyed = false;
    (res as unknown as { destroy: () => void }).destroy = () => {
      destroyed = true;
      setImmediate(() => { res.emit('aborted'); res.emit('close'); });
    };
    cb(res);
    setImmediate(() => {
      res.emit('data', Buffer.from(nextReply.body, 'utf8'));
      if (nextReply.dropMidway) {
        // 对端中途断开（连接被掐）：真实 Node（已用真实 http 实测）依次发 aborted → error('aborted') → close，
        // **不发 end**——我们并没有主动 destroy。
        setImmediate(() => { res.emit('aborted'); res.emit('error', new Error('aborted')); res.emit('close'); });
        return;
      }
      if (!destroyed) res.emit('end');
    });
  };
  return req;
}
vi.mock('node:http', async (orig) => ({ ...(await orig<typeof import('node:http')>()), request: fakeRequest }));
vi.mock('node:https', async (orig) => ({ ...(await orig<typeof import('node:https')>()), request: fakeRequest }));

const { fetchToSandboxFile, FETCH_TO_FILE_MAX_BYTES } = await import('../../../src/sandbox/fetch-to-file.js');

beforeEach(() => {
  sandboxRoot = mkdtempSync(join(tmpdir(), 'xxb-f2f-'));
  outbound.length = 0;
  dnsTable.clear();
  dnsTable.set('feeds.example.org', ['93.184.216.34']);
  dnsTable.set('evil-rebind.example.org', ['10.0.0.5']);
  nextReply = { status: 200, headers: { 'content-type': 'application/rss+xml; charset=utf-8' }, body: '<rss><channel><title>t</title></channel></rss>' };
});
afterEach(() => {
  rmSync(sandboxRoot, { recursive: true, force: true });
});

describe('SSRF 守卫没有被绕过（真实判定，出站不应发生）', () => {
  it('① loopback / 私网 / 云元数据 IP → 拦，且没有任何出站', async () => {
    for (const u of ['http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://192.168.1.1/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://localhost/x']) {
      const r = await fetchToSandboxFile(u, 'out.txt');
      expect(r.ok, u).toBe(false);
    }
    expect(outbound).toEqual([]);
    expect(readdirSync(sandboxRoot)).toEqual([]);
  });

  it('② 非白名单端口（Redis 6379 / Qdrant 6333 / 本机 fetch 服务 8900）→ 拦，且没有出站', async () => {
    for (const u of ['http://feeds.example.org:6379/', 'http://feeds.example.org:6333/collections', 'http://feeds.example.org:8900/']) {
      const r = await fetchToSandboxFile(u, 'out.txt');
      expect(r.ok, u).toBe(false);
    }
    expect(outbound).toEqual([]);
  });

  it('③ 域名解析到私网地址（DNS rebinding 形状）→ 拦，且没有出站', async () => {
    const r = await fetchToSandboxFile('https://evil-rebind.example.org/feed.xml', 'out.txt');
    expect(r.ok).toBe(false);
    expect(outbound).toEqual([]);
  });

  it('⑧ 失败原因不回显内网细节（否则成了内网探针）', async () => {
    const r = await fetchToSandboxFile('https://evil-rebind.example.org/feed.xml', 'out.txt');
    expect(JSON.stringify(r)).not.toMatch(/10\.0\.0\.5|private|10\./);
    const r2 = await fetchToSandboxFile('http://169.254.169.254/', 'out.txt');
    expect(JSON.stringify(r2)).not.toMatch(/169\.254/);
  });

  it('非 http(s) 协议 → 拒绝', async () => {
    for (const u of ['file:///etc/passwd', 'ftp://feeds.example.org/x', 'gopher://feeds.example.org/']) {
      const r = await fetchToSandboxFile(u, 'out.txt');
      expect(r.ok, u).toBe(false);
    }
    expect(outbound).toEqual([]);
  });
});

describe('内容与落盘约束', () => {
  it('⑦ 正常 RSS → 写进沙盒，内容一致，出站只有一次且打到解析出的公网 IP', async () => {
    const r = await fetchToSandboxFile('https://feeds.example.org/rss.xml', 'data/rss.xml');
    expect(r.ok).toBe(true);
    expect(r.path).toBe('data/rss.xml');
    expect(readFileSync(join(sandboxRoot, 'data/rss.xml'), 'utf8')).toBe(nextReply.body);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.host).toBe('93.184.216.34');   // 钉定到解析出的 IP，不是再走一次 DNS
  });

  it('④a 非文本 content-type（二进制/压缩包/可执行）→ 不写文件', async () => {
    for (const ct of ['application/octet-stream', 'application/zip', 'image/png', 'application/x-msdownload']) {
      nextReply = { status: 200, headers: { 'content-type': ct }, body: 'BIN' };
      const r = await fetchToSandboxFile('https://feeds.example.org/f', 'bin.dat');
      expect(r.ok, ct).toBe(false);
    }
    expect(existsSync(join(sandboxRoot, 'bin.dat'))).toBe(false);
  });

  it('④b 没有 content-type → 不确定，拒绝（宁可换来源，也不写不明内容）', async () => {
    nextReply = { status: 200, headers: {}, body: 'whatever' };
    const r = await fetchToSandboxFile('https://feeds.example.org/f', 'x.txt');
    expect(r.ok).toBe(false);
    expect(existsSync(join(sandboxRoot, 'x.txt'))).toBe(false);
  });

  it('JSON / CSV / HTML / text 都放行', async () => {
    for (const ct of ['application/json', 'text/csv', 'text/html; charset=utf-8', 'text/plain', 'application/atom+xml', 'application/vnd.api+json']) {
      nextReply = { status: 200, headers: { 'content-type': ct }, body: 'ok' };
      const r = await fetchToSandboxFile('https://feeds.example.org/f', `ok-${ct.replace(/[^a-z]/g, '')}.txt`);
      expect(r.ok, ct).toBe(true);
    }
  });

  it('⑤ 超过体积上限 → 截断并明说 truncated；落盘不超过上限', async () => {
    nextReply = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(FETCH_TO_FILE_MAX_BYTES + 5000) };
    const r = await fetchToSandboxFile('https://feeds.example.org/big', 'big.txt');
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(r.truncated).toBe(true);
    expect(statBytes(join(sandboxRoot, 'big.txt'))).toBeLessThanOrEqual(FETCH_TO_FILE_MAX_BYTES);
  });

  it('⑤b 恰好在上限以内的正常内容 → truncated 为 false（不能把所有东西都报成被截断）', async () => {
    nextReply = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'y'.repeat(FETCH_TO_FILE_MAX_BYTES - 1000) };
    const r = await fetchToSandboxFile('https://feeds.example.org/near', 'near.txt');
    expect(r).toMatchObject({ ok: true, truncated: false });
  });

  it('⑤c 对端中途断开 → 失败，且半截内容不会被写成沙盒文件', async () => {
    // 锁的是**结果**：沙盒里的脚本解析时若拿到悄悄少了一半的 RSS/JSON，比拿到明确的失败更糟。
    // 事件序列与真实 Node 一致（已用真实 http 实测）：aborted → error('aborted') → close，没有 end。
    nextReply = { status: 200, headers: { 'content-type': 'application/rss+xml' }, body: '<rss><channel><item>半截', dropMidway: true };
    const r = await fetchToSandboxFile('https://feeds.example.org/cut', 'cut.xml');
    expect(r.ok).toBe(false);
    expect(existsSync(join(sandboxRoot, 'cut.xml'))).toBe(false);
  });

  it('非 2xx → 不写文件', async () => {
    nextReply = { status: 404, headers: { 'content-type': 'text/html' }, body: 'nope' };
    const r = await fetchToSandboxFile('https://feeds.example.org/missing', 'm.txt');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/404/);
    expect(existsSync(join(sandboxRoot, 'm.txt'))).toBe(false);
  });

  it('⑥ 路径逃逸 → 拒绝，且没有文件落在沙盒外', async () => {
    const outside = join(sandboxRoot, '..', `escaped-${Date.now()}.txt`);
    const r = await fetchToSandboxFile('https://feeds.example.org/rss.xml', `../${outside.split('/').pop()}`);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/path_escape/);
    expect(existsSync(outside)).toBe(false);
    const abs = await fetchToSandboxFile('https://feeds.example.org/rss.xml', '/etc/xxb-should-not-exist');
    expect(abs.ok).toBe(false);
    expect(existsSync('/etc/xxb-should-not-exist')).toBe(false);
  });

  it('空路径 / 非法 URL → 拒绝', async () => {
    expect((await fetchToSandboxFile('https://feeds.example.org/', '')).ok).toBe(false);
    expect((await fetchToSandboxFile('not a url', 'x.txt')).ok).toBe(false);
    expect(outbound).toEqual([]);
  });
});

describe('接线与默认值', () => {
  it('⑨ flag 默认关，且 host-api 在关着时不抓', () => {
    const sec = readFileSync('src/env-sections/features.ts', 'utf8');
    expect(sec).toMatch(/CODEACT_WEB_FETCH_TO_FILE_ENABLED:\s*booleanFromEnv\.default\(false\)/);
    const api = readFileSync('src/subagent/host-api.ts', 'utf8');
    const i = api.indexOf('async fetchToFile(');
    expect(i).toBeGreaterThan(0);
    expect(api.slice(i, i + 400)).toContain('CODEACT_WEB_FETCH_TO_FILE_ENABLED');
    expect(api.slice(i, i + 900)).toContain("import('../sandbox/fetch-to-file.js')");
  });

  it('沙盒仍然没有网络：bwrap 参数里是 --unshare-all，且没有 --share-net', () => {
    const t = readFileSync('src/sandbox/terminal.ts', 'utf8');
    expect(t).toContain("'--unshare-all'");
    expect(t).not.toContain('--share-net');
  });

  it('宿主抓取能力不会自动成为隔离 guest API；普通和自玩运行提示均不宣传', () => {
    const source = readFileSync('src/subagent/executor.ts', 'utf8');
    const template = source.match(/const EXECUTOR_SYSTEM = `([\s\S]*?)\n`;/)?.[1];
    expect(template).toBeTruthy();
    const selfPlay = readFileSync('prompts/task/self-play.md', 'utf8');
    for (const prompt of [template!, selfPlay]) {
      expect(buildCodeActSystemPrompt(prompt)).not.toContain('web.fetchToFile');
    }
    const selected = selectCodeActCapabilities({ web: { fetchToFile: vi.fn(), search: vi.fn() } }, CODEACT_CAPABILITY_METHODS);
    expect(selected.has('web.fetchToFile')).toBe(false);
    expect(selected.has('web.search')).toBe(true);
  });
});

function statBytes(p: string): number {
  return readFileSync(p).byteLength;
}
