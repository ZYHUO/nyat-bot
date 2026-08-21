// ────────────────────────────────────────
// 天气环境感知（真人感演进：真人会说「今天好热」「下雨了」，bot 也该知道）
// ────────────────────────────────────────
//
// wttr.in 免费端点（无需 key），Redis 缓存 30 分钟 + 进程内兜底。
// 全链路 fail-soft：超时/解析失败/未启用一律返回 null，绝不阻塞 prompt 组装。

import { env } from '../env.js';
import { logger } from './logger.js';

const CACHE_KEY = 'xxb:weather:hint';
const CACHE_SEC = 1800; // 30min
const FETCH_TIMEOUT_MS = 4000;

let memCache: { text: string; at: number } | null = null;

interface WttrResp {
  current_condition?: Array<{
    temp_C?: string;
    FeelsLikeC?: string;
    humidity?: string;
    lang_zh?: Array<{ value?: string }>;
    weatherDesc?: Array<{ value?: string }>;
  }>;
}

async function fetchWeatherText(city: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'nyat-bot-weather/1.0' },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as WttrResp;
    const c = j.current_condition?.[0];
    if (!c?.temp_C) return null;
    const desc =
      c.lang_zh?.[0]?.value?.trim() || c.weatherDesc?.[0]?.value?.trim() || '';
    const feelsPart =
      c.FeelsLikeC && c.FeelsLikeC !== c.temp_C ? `，体感 ${c.FeelsLikeC}°C` : '';
    // 第一人称环境事实；提不提、怎么提由 bot 决定
    return `你那边现在 ${c.temp_C}°C${desc ? `，${desc}` : ''}${feelsPart}`;
  } catch (err) {
    logger.debug({ err, city }, 'weather fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 当前天气一句话（缓存优先），失败/未启用返回 null。 */
export async function getWeatherHint(): Promise<string | null> {  if (!env().WEATHER_ENABLED) return null;

  try {
    const { getRedis } = await import('../db/redis.js');
    const cached = await getRedis().get(CACHE_KEY);
    if (cached) return cached;
  } catch {
    /* Redis 挂了走进程内缓存 */
  }
  if (memCache && Date.now() - memCache.at < CACHE_SEC * 1000) return memCache.text;

  const text = await fetchWeatherText(env().WEATHER_CITY || 'Beijing');
  if (!text) return null;

  memCache = { text, at: Date.now() };
  try {
    const { getRedis } = await import('../db/redis.js');
    await getRedis().set(CACHE_KEY, text, 'EX', CACHE_SEC);
  } catch {
    /* memCache 已兜 */
  }
  return text;
}

/** 测试用：清进程内缓存（labels.ts 的 _resetLabels 同款惯例）。 */
export function _resetWeatherCacheForTest(): void {
  memCache = null;
}
