import type { FormattedMessage } from '../shared/types.js';

export type PathPattern =
  | 'realtime_info'
  | 'link_inspect'
  | 'market_quote'
  | 'followup_lookup';

const URL_OR_DOMAIN_RE = /https?:\/\/\S+|\b[a-z0-9-]+\.(com|net|org|io|cn|ru|wiki|dev|app|xyz|me|cc|co)\b/i;
const INSPECT_VERB_RE = /(看一下|看看这个|这个呢|查一下|搜一下|读一下|打开|网页|网站|链接|link|url|fetch|web fetch)/i;
const QUERY_VERB_RE = /(看一下|看看|查一下|搜一下|帮我查|帮我看|帮我搜|告诉我|说说|多少|几度|几点|怎么样|如何|有没有|有吗|值多少|多少刀|多少美元|多少港币)/i;
const QUESTION_RE = /[?？]/;
const REALTIME_TOPIC_RE = /(天气|气温|温度|降雨|预报|湿度|风力|空气质量|aqi|汇率|油价|新闻|热点|热搜|时间|日期|weather|forecast|temperature|news|rate|time)/i;
const MARKET_TOPIC_RE = /(股票|股价|行情|市值|盘前|盘后|price|stock|market|ticker|币价|币圈|币|btc|eth|nvda|msft|aapl|tsla|英伟达|微软|苹果|特斯拉|老黄|巨硬)/i;
const REALTIME_QUALIFIER_RE = /(最新|实时|现在|今天|明天|后天|当前|today|tomorrow|current|latest|now)/i;
const FOLLOWUP_RE = /(呢|那|这个|那个|还有|咋样|怎么样|如何|老黄|巨硬|英伟达|微软|苹果|特斯拉|巴黎|东京|莫斯科|新加坡)/i;

function isQueryLike(text: string): boolean {
  return QUERY_VERB_RE.test(text) || QUESTION_RE.test(text);
}

function looksLikeRealtimeInfoRequest(text: string): boolean {
  const hasRealtimeTopic = REALTIME_TOPIC_RE.test(text);
  if (!hasRealtimeTopic) return false;
  return isQueryLike(text) || REALTIME_QUALIFIER_RE.test(text);
}

function looksLikeMarketQuoteRequest(text: string): boolean {
  const hasMarketTopic = MARKET_TOPIC_RE.test(text);
  if (!hasMarketTopic) return false;
  return isQueryLike(text) || REALTIME_QUALIFIER_RE.test(text);
}

export function looksLikeExternalLookupRequest(text: string, recentTexts?: string[]): boolean {
  if (URL_OR_DOMAIN_RE.test(text) && INSPECT_VERB_RE.test(text)) return true;
  if (looksLikeRealtimeInfoRequest(text)) return true;
  if (looksLikeMarketQuoteRequest(text)) return true;
  if (looksLikeSearchIntent(text)) return true;
  // "看看这个" / "看看" with a URL in recent context (user sent URL then asked bot to look)
  if (INSPECT_VERB_RE.test(text) && recentTexts?.some((t) => URL_OR_DOMAIN_RE.test(t))) return true;
  return false;
}

/**
 * Detect generic search/lookup intent in natural language.
 * Matches patterns like "去搜一下 xxx", "帮我搜 xxx", "search for xxx", "查查 xxx 是什么" etc.
 */
const SEARCH_INTENT_RE = /(?:去|帮我?|你)?(?:搜一下|搜搜|搜索|查一下|查查|查找|找一下|找找|google|search|look\s*up|搜一搜|百度|bing|谷歌)\s*\S/i;
const LATEST_CONTENT_RE = /(?:新帖|新贴|最新|latest|今天.*帖|有什么新|有啥新|最近.*帖)/i;
const SITE_SHORTHAND_RE = /\b(?:ns|nodeseek|loc|hostloc|linux\.do|v2ex|mjj)\b/i;
const LOOKUP_INTENT_RE = /(?:是什么|是谁|是啥|怎么回事|什么意思|啥意思|有什么用|干什么的|干嘛的|有什么区别|区别是什么|对比一下|比较一下|评价一下|介绍一下|了解一下|科普一下)/i;

function looksLikeSearchIntent(text: string): boolean {
  if (SEARCH_INTENT_RE.test(text)) return true;
  // "ns新帖" / "linux.do最新" / "今天有什么新帖" style
  if (LATEST_CONTENT_RE.test(text) && SITE_SHORTHAND_RE.test(text)) return true;
  if (LATEST_CONTENT_RE.test(text) && URL_OR_DOMAIN_RE.test(text)) return true;
  // "xxx 是什么/是谁" style questions that benefit from web search
  if (LOOKUP_INTENT_RE.test(text) && QUERY_VERB_RE.test(text)) return true;
  return false;
}

export function looksLikeFollowupLookupRequest(
  message: FormattedMessage,
  botUid: number,
): boolean {
  if (message.replyTo?.uid !== botUid) return false;

  const currentText = (message.textContent || message.captionContent || '').trim();
  const repliedSnippet = message.replyTo.textSnippet || '';
  if (!currentText || !repliedSnippet) return false;

  const shortFollowup = currentText.length <= 24;
  const followupCue = FOLLOWUP_RE.test(currentText);
  const repliedLooksLookup =
    looksLikeRealtimeInfoRequest(repliedSnippet) ||
    looksLikeMarketQuoteRequest(repliedSnippet) ||
    URL_OR_DOMAIN_RE.test(repliedSnippet) ||
    /(美元|欧元|港币|多云|阵雨|晴|阴|股票代码|股价|price|weather|forecast)/i.test(repliedSnippet);

  return repliedLooksLookup && (shortFollowup || followupCue);
}

export function detectPathPatterns(
  message: FormattedMessage,
  botUid: number,
): PathPattern[] {
  const text = (message.textContent || message.captionContent || '').trim();
  const patterns: PathPattern[] = [];

  if (looksLikeFollowupLookupRequest(message, botUid)) {
    patterns.push('followup_lookup');
  }

  if (URL_OR_DOMAIN_RE.test(text) && INSPECT_VERB_RE.test(text)) {
    patterns.push('link_inspect');
  }

  if (looksLikeRealtimeInfoRequest(text)) {
    patterns.push('realtime_info');
  }

  if (looksLikeMarketQuoteRequest(text)) {
    patterns.push('market_quote');
  }

  return [...new Set(patterns)];
}
