// ────────────────────────────────────────
// Chat Style — 群风格统计(#6 长度镜像 + #11 标点/emoji 漂移 + #3 引用率)
// ────────────────────────────────────────
//
// 真人会"融入房间":短句群跟着发短句、没人用句号就不用句号、小群没人
// quote 就不 quote。bot 此前所有风格参数全局一刀切,跨群同一张脸。
// 这里从最近人类消息滚动统计本群习惯,供 segmenter/humanizer/quote-policy
// 调制(向群中位数**回归**,不是 1:1 模仿)。
//
// 进程内缓存 10 分钟;样本 <15 条返回 null(用全局默认,不强行学样)。

import { getRecent } from '../pipeline/context/manager.js';
import { logger } from '../shared/logger.js';

export interface ChatStyle {
  /** 人类消息长度中位数(字符) */
  medianChars: number;
  /** 带 emoji 的消息占比 0..1 */
  emojiDensity: number;
  /** 人类消息带引用(replyTo)的占比 0..1 */
  quoteRatio: number;
  /** 以句号/感叹/问号收尾的消息占比 0..1 */
  punctEndRate: number;
  /** 微反应群:中位数 ≤12 字(对对对/笑死/草 式短打群) */
  microStyle: boolean;
  sampleSize: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<number, { style: ChatStyle | null; at: number }>();

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
const PUNCT_END_RE = /[。.!?!?~~…]$/;

export async function getChatStyle(chatId: number): Promise<ChatStyle | null> {
  const hit = cache.get(chatId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.style;

  let style: ChatStyle | null = null;
  try {
    const recent = await getRecent(chatId, 60);
    const humans = recent.filter(
      (m) => m.role !== 'assistant' && !m.isBot && (m.textContent || '').trim().length > 0,
    );
    if (humans.length >= 15) {
      const lens = humans.map((m) => m.textContent.length).sort((a, b) => a - b);
      const medianChars = lens[Math.floor(lens.length / 2)]!;
      const emojiDensity = humans.filter((m) => EMOJI_RE.test(m.textContent)).length / humans.length;
      const quoteRatio = humans.filter((m) => !!m.replyTo).length / humans.length;
      const punctEndRate = humans.filter((m) => PUNCT_END_RE.test(m.textContent.trim())).length / humans.length;
      style = { medianChars, emojiDensity, quoteRatio, punctEndRate, microStyle: medianChars <= 12, sampleSize: humans.length };
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'getChatStyle failed (non-critical)');
  }

  cache.set(chatId, { style, at: Date.now() });
  return style;
}

/** 由群风格导出的 segmenter 参数(作为 underlay,运营 override 优先) */
export function styleSegmenterOverlay(style: ChatStyle): {
  maxLength: number;
  maxSentenceNum: number;
  periodDropRate: number;
} {
  return {
    // 回复长度上限随群中位数走:短句群 ~60,长文群放宽到 280
    maxLength: Math.min(280, Math.max(60, Math.round(style.medianChars * 2.5))),
    maxSentenceNum: style.medianChars < 25 ? 2 : 3,
    // 群里没人句号结尾 → bot 也基本不留句号;反之收敛保留
    periodDropRate: Math.min(0.97, Math.max(0.5, 1 - style.punctEndRate)),
  };
}

/** 由群风格导出的 humanizer 参数 underlay */
export function styleHumanizerOverlay(style: ChatStyle): {
  ackPrefixMinLength: number;
  emojiReplyRate: number;
} {
  return {
    // 短句群把 ack 阈值抬高(几乎禁用——大家都一句话,你"嗯"什么)
    ackPrefixMinLength: Math.min(80, Math.max(24, Math.round(style.medianChars * 1.5))),
    // emoji 率向群密度回归(0.05–0.3 之间)
    emojiReplyRate: Math.min(0.3, Math.max(0.05, style.emojiDensity * 0.8)),
  };
}

/** 测试用 */
export function _resetChatStyleCache(): void {
  cache.clear();
}
