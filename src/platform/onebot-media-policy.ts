import { OneBotMediaError } from './onebot-media-stream.js';

const CDN_HOSTS = ['qq.com', 'qpic.cn', 'gtimg.cn', 'gtimg.com'];

/** Pure source allowlist. DNS and redirect checks still run at every HTTP hop. */
export function assertOneBotMediaUrl(input: string): URL {
  try {
    if (typeof input !== 'string' || input.length > 4096) throw new Error();
    const url = new URL(input);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.hash || url.port ||
      !CDN_HOSTS.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error();
    return url;
  } catch { throw new OneBotMediaError('qq_media_url_refused'); }
}
