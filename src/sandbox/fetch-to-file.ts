// ────────────────────────────────────────
// web.fetchToFile —— 沙盒不联网，数据由宿主侧带进来
// ────────────────────────────────────────
//
// 沙盒是 `bwrap --unshare-all`，没有任何网络出口——这是有意的，是 CodeAct 终端能力的安全边界。
// 给它开网络要么 --share-net（沙盒内代码就能直连宿主 loopback 上的 Redis 6379 / Qdrant 6333，
// 全无认证），要么另搭 netns + nftables（独立的、有风险的工程）。
//
// 2026-10-01 03:48 那次 self-play 失败是 `沙盒无 DNS，fetch_rss.py 四个源全部 name resolution
// 失败`：模型想在沙盒里自己抓 RSS。缺的不是网络，是一条**受控的**"把外部数据带进沙盒"的通道。
//
// 这里：宿主用既有的 fetchUrlPinned 抓（SSRF 守卫：协议 / 端口白名单 / DNS 解析一次后钉定 IP /
// 逐跳重定向重新校验，全部沿用），把正文写进沙盒目录；沙盒里的脚本读文件处理。网络始终在宿主侧。
//
// 额外约束（相对 web.fetch 更紧——这里的产物会被**模型写的代码**当文件读，不是给模型看的摘要）：
//   · 只放行文本类 content-type（text/* / json / xml / rss / atom / csv / javascript 文本）
//   · 体积上限 MAX_BYTES；超了就截断并在返回值里明说
//   · 目标路径必须在沙盒内（resolveInsideSandbox，沿用 path_escape 拦截）
//   · 不跟随到私网（fetchUrlPinned 内部逐跳校验）

import { logger } from '../shared/logger.js';
import { fetchUrlPinned, SsrfBlockedError } from '../pipeline/tools/ssrf.js';
import { sandboxWriteFile } from './files.js';

/** 单次抓取写入沙盒的字节上限。RSS/JSON/CSV 够用；二进制/大文件不该走这条路。 */
export const FETCH_TO_FILE_MAX_BYTES = 512 * 1024;

const TEXT_CT = /^(?:text\/|application\/(?:json|xml|rss\+xml|atom\+xml|xhtml\+xml|javascript|x-ndjson|ld\+json|csv)|[a-z]+\/[a-z0-9.+-]*\+(?:json|xml))/i;

export interface FetchToFileResult {
  ok: boolean;
  /** 沙盒内相对路径（成功时）。 */
  path?: string;
  bytes?: number;
  contentType?: string;
  finalUrl?: string;
  truncated?: boolean;
  /** 失败原因（给模型看的，不含内网地址等细节）。 */
  reason?: string;
}

export async function fetchToSandboxFile(
  url: string,
  relPath: string,
  opts: { userAgent?: string } = {},
): Promise<FetchToFileResult> {
  const target = String(relPath ?? '').trim();
  if (!target) return { ok: false, reason: 'empty path' };

  let parsed: URL;
  try {
    parsed = new URL(String(url ?? '').trim());
  } catch {
    return { ok: false, reason: 'invalid url' };
  }

  let res;
  try {
    res = await fetchUrlPinned(parsed.toString(), {
      headers: { 'User-Agent': opts.userAgent ?? 'Mozilla/5.0 (compatible; nyatbot-fetch)' },
      maxBytes: FETCH_TO_FILE_MAX_BYTES,
      timeoutMs: 20_000,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      // 不回显具体原因（会被当成内网探针）；详情只进日志。
      logger.warn({ url: parsed.hostname, err: err.message }, 'fetchToFile: SSRF blocked');
      return { ok: false, reason: 'blocked: address not allowed' };
    }
    return { ok: false, reason: `fetch failed: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}` };
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    return { ok: false, reason: `http ${res.statusCode}` };
  }

  const ctRaw = res.headers['content-type'];
  const contentType = (Array.isArray(ctRaw) ? ctRaw[0] : ctRaw) ?? '';
  // 没有 content-type 的当不确定 → 拒绝（宁可让模型换个来源，也不把不明二进制写进沙盒）。
  if (!TEXT_CT.test(contentType.trim())) {
    return { ok: false, reason: `content-type not text: ${contentType.slice(0, 60) || '(none)'}` };
  }

  // fetchUrlPinned 在传输层就按 maxBytes 截断（读够就 destroy），所以走到这里 body 至多是上限那么大。
  // 「恰好等于上限」就是被截断的信号——不能只看「超过上限」：传输层已经替我们截掉了超出的部分，
  // 只比较 > 上限会永远判成「没截断」，模型会把半截的 RSS/JSON 当完整的去解析。
  // 按 UTF-8 字节数比（截断可能落在多字节字符中间，toString 会产生一个替换符，字节数略小于上限，
  // 所以留一个字符的余量：≥ 上限 - 4 都算触顶）。
  let body = res.body;
  const buf = Buffer.from(body, 'utf8');
  let truncated = buf.byteLength >= FETCH_TO_FILE_MAX_BYTES - 4;
  if (buf.byteLength > FETCH_TO_FILE_MAX_BYTES) {
    body = buf.subarray(0, FETCH_TO_FILE_MAX_BYTES).toString('utf8');
    truncated = true;
  }

  try {
    const w = await sandboxWriteFile(target, body);
    return {
      ok: true,
      path: w.path,
      bytes: Buffer.byteLength(body, 'utf8'),
      contentType: contentType.slice(0, 80),
      finalUrl: res.finalUrl,
      truncated,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // path_escape 之类的沙盒路径错误直接回给模型（它需要知道自己写错了路径）。
    return { ok: false, reason: msg.slice(0, 120) };
  }
}
