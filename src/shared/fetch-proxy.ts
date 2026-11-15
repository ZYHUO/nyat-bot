// ────────────────────────────────────────
// 全局 fetch 代理 — KVM 等受限网络用（TG Bot API / LLM / Gemini / web-fetch 全走它）
//
// 行为：GLOBAL_FETCH_PROXY 留空 = 不动（本机直连）；设了之后：
// - 公网 https/http → 经 undici ProxyAgent 走代理
// - 本地地址（localhost/127/10/172.16/192.168，以及 :6333/:6379/:7863/:7864/:3000 等）
//   → 直连，Redis/Qdrant/本地网关不受影响
// 实现：替换 globalThis.fetch（Node 22 原生 fetch 基于 undici，dispatcher 生效；
// 已验证 ProxyAgent(http://127.0.0.1:1081) + TG 200）。
// ────────────────────────────────────────
import { ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';

const DIRECT_SUFFIXES = ['localhost', '127.0.0.1', '::1'];
const DIRECT_PREFIXES = ['10.', '192.168.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.'];

function isDirectHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (DIRECT_SUFFIXES.includes(h)) return true;
  return DIRECT_PREFIXES.some((p) => h.startsWith(p));
}

export function isDirectUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    return isDirectHost(u.hostname);
  } catch {
    return true;
  }
}

let _installed = false;
let _proxyUrl = '';

export function installGlobalFetchProxy(proxyUrl: string | undefined): boolean {
  if (!proxyUrl) return false;
  if (_installed && _proxyUrl === proxyUrl) return true;
  const agent = new ProxyAgent(proxyUrl);
  const direct = getGlobalDispatcher();
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request)?.url ?? '';
    if (url && isDirectUrl(url)) return nativeFetch(input as never, init);
    return nativeFetch(input as never, { ...(init ?? {}), dispatcher: agent } as never);
  }) as typeof fetch;
  // 非 fetch 路径（如 AI SDK 内部不用 global fetch 的）也尽量覆盖
  try {
    setGlobalDispatcher(agent);
  } catch {
    void direct;
  }
  _installed = true;
  _proxyUrl = proxyUrl;
  return true;
}
