// ────────────────────────────────────────
// IP quality query tool
// Port of PHP ToolService::queryIpQuality()
// ────────────────────────────────────────

import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

export async function executeIpQuality(ip: string): Promise<string> {
  const e = env();
  if (!e.IP_QUALITY_API_URL) return 'IP查询工具未配置。';

  if (!ip || ip.length > 253) return `无效的IP地址或域名格式: ${ip}`;

  const url = `${e.IP_QUALITY_API_URL}?ip=${encodeURIComponent(ip)}&raw_mode=true`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return `查询IP信息失败: API返回状态码 ${res.status}`;

    const data = (await res.json()) as Record<string, unknown>;
    if (data.error) return `查询IP ${ip} 时出错: ${String(data.error)}`;

    return JSON.stringify(data);
  } catch (err) {
    logger.error({ err, ip }, 'IP quality query failed');
    return `查询IP信息失败: ${err instanceof Error ? err.message : String(err)}`;
  }
}
