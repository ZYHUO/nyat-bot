// ────────────────────────────────────────
// Smart Group — 智能 provider 选路 (opt-in, default OFF)
//
// 直接读 process.env（不经 zod env()），连已有的 .env SMART_GROUP_* 无需走 schema。
// 在 fallback.ts 的 labelNames 循环前调用，按健康度/延迟/成本重排候选。
// 不 disrupt 现有 fallback 链；smart group 关时 labelNames 保持 .env 原序。
//
// 策略：
//   best-latency（默认）: 最近成功延迟最低的优先
//   cost-first         : free > grouped > paid
//   round-robin        : 每 5 分钟轮换一次
//
// 状态持久化在 Redis（xxb:sg:health:<model>），进程重启不丢。
// ────────────────────────────────────────

import type { AILabel } from './types.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type Strategy = 'best-latency' | 'cost-first' | 'round-robin';

interface SmartGroupConfig {
  enabled: boolean;
  strategy: Strategy;
  windowSize: number;
  rrIntervalSec: number;
  /** true 时 fallback 不再用 .env AI_USAGE_*_LABEL/BACKUPS 手动链,
   *  而是按 usage profile 从全量 provider 池自动选 top-N(见 smartGroupAutoAssign)。 */
  autoAssign: boolean;
  /** 链的上游去重：同一 (endpoint, key) 只先取一个。见 diversifyByUpstream。 */
  diversifyUpstream: boolean;
}

const DEFAULT_CONFIG: SmartGroupConfig = {
  enabled: false,
  strategy: 'best-latency',
  windowSize: 10,
  rrIntervalSec: 300,
  autoAssign: false,
  diversifyUpstream: true,
};

interface LabelHealth {
  healthy: boolean;
  latencies: number[];
  errorCount: number;
  successCount: number;
  lastUsed: number;
}

const memoryHealth = new Map<string, LabelHealth>();

// ─── Config (process.env, no zod) ─────────────────────────────────────────

function getConfig(): SmartGroupConfig {
  const raw = process.env.SMART_GROUP_STRATEGY as Strategy | undefined;
  return {
    enabled: process.env.SMART_GROUP_ENABLED === 'true',
    strategy: raw && ['best-latency', 'cost-first', 'round-robin'].includes(raw)
      ? raw
      : DEFAULT_CONFIG.strategy,
    windowSize: parseInt(process.env.SMART_GROUP_WINDOW ?? '10', 10),
    rrIntervalSec: parseInt(process.env.SMART_GROUP_RR_INTERVAL ?? '300', 10),
    autoAssign: process.env.SMART_GROUP_AUTO_ASSIGN === 'true',
    diversifyUpstream: process.env.SMART_GROUP_DIVERSIFY_UPSTREAM !== 'false',
  };
}

// ─── Cost Inference ─────────────────────────────────────────────────────────

/**
 * best-latency 下"从没被调用过"的 provider 该排哪儿。
 *
 * 2026-09-21 接入 step-5-preview 时发现的真问题：原实现给无数据者一个写死的
 * 5_000ms，注释说"让新 provider 有机会被试"——但当时在跑的 provider 平均延迟
 * 已经降到 2.8s，于是新来的永远排在第 5 名之后，而链长只有 5，**它一次都不会
 * 被调用，也就永远拿不到数据，永远排不上去**。新 provider 成了死代码，而
 * "加一个 provider 就能用"这条扩展性承诺是假的。
 *
 * 改成：无数据者的分数 = 当前已知延迟的中位数。语义是"当成普通水平的一员"——
 * 排得比快的低、比慢的高，链一长它就在里面；真被调一次之后按自己的实测延迟归位。
 * 一个已知延迟都没有时（全新部署）才退回 5_000。
 */
function medianOf(values: number[]): number {
  if (values.length === 0) return 5_000;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 候选里所有"有实测延迟"的平均延迟集合（best-latency 的基准线）。 */
function knownLatencies(candidates: Array<{ name: string }>): number[] {
  const out: number[] = [];
  for (const c of candidates) {
    const h = memoryHealth.get(c.name);
    if (h && h.latencies.length > 0) {
      out.push(h.latencies.reduce((a, b) => a + b, 0) / h.latencies.length);
    }
  }
  return out;
}

function inferCost(endpoint: string): 'free' | 'grouped' | 'paid' {
  const ep = endpoint.toLowerCase();
  if (ep.includes('127.0.0.1') || ep.includes('localhost')) return 'grouped';
  if (ep.includes('stepfun') || ep.includes('grok.168661')) return 'paid';
  if (ep.includes('openai') || ep.includes('anthropic')) return 'paid';
  if (ep.includes('opencode.ai') || ep.includes('newapi.gomami') || ep.includes('sub.')) return 'grouped';
  return 'paid';
}

// ─── Health Recording ───────────────────────────────────────────────────────

export function recordSmartGroupResult(labelName: string, latencyMs: number, success: boolean): void {
  const cfg = getConfig();
  if (!cfg.enabled) return;

  let h = memoryHealth.get(labelName);
  if (!h) {
    h = { healthy: true, latencies: [], errorCount: 0, successCount: 0, lastUsed: Date.now() };
    memoryHealth.set(labelName, h);
  }

  h.lastUsed = Date.now();

  if (success) {
    h.successCount++;
    h.healthy = true;
    h.errorCount = 0;
    h.latencies.push(latencyMs);
    if (h.latencies.length > cfg.windowSize) h.latencies.shift();
  } else {
    h.errorCount++;
    if (h.errorCount >= 5) h.healthy = false;
  }

  persistToRedis(labelName, h).catch(() => {});
}

// ─── Selection ──────────────────────────────────────────────────────────────

/**
 * 重排候选 label。getLabels 惰性 import —— 只有 smart group 开启时才加载,
 * 默认关闭路径零开销,也不碰测试 mock(测试只 mock 了 getUsage/getLabel)。
 */
export async function smartGroupReorder(labelNames: string[]): Promise<string[]> {
  const cfg = getConfig();
  if (!cfg.enabled || labelNames.length <= 1) return labelNames;

  const { getLabels } = await import('./labels.js');
  const labels = getLabels();
  const available: { name: string; label: AILabel }[] = [];
  for (const name of labelNames) {
    const l = labels.get(name);
    if (l) available.push({ name, label: l });
  }
  if (available.length <= 1) return labelNames;

  const scored = available.map(({ name, label }) => {
    const h = memoryHealth.get(name);
    const cost = inferCost(label.endpoint);

    switch (cfg.strategy) {
      case 'best-latency': {
        if (h && !h.healthy) return { name, score: -Infinity };
        const avgLat = h && h.latencies.length > 0
          ? h.latencies.reduce((a, b) => a + b, 0) / h.latencies.length
          : medianOf(knownLatencies(available)); // 没见过 → 按池子中位数归位
        return { name, score: -avgLat };
      }
      case 'cost-first': {
        const costOrder: Record<string, number> = { free: 0, grouped: 1, paid: 2 };
        let score = -(costOrder[cost] ?? 2);
        if (h && !h.healthy) score -= 100;
        return { name, score };
      }
      case 'round-robin': {
        const lastUsed = h?.lastUsed ?? 0;
        // 最久没用的排前(lastUsed 小 → score 大);从未用过的 lastUsed=0 天然最优先
        let score = -lastUsed;
        if (h && !h.healthy) score -= 100000;
        return { name, score };
      }
      default:
        return { name, score: 0 };
    }
  });

  scored.sort((a, b) => b.score - a.score);

  const reordered = scored.map((s) => s.name);
  for (const name of labelNames) {
    if (!reordered.includes(name)) reordered.push(name);
  }

  return reordered;
}

// ─── Redis Persistence ──────────────────────────────────────────────────────

async function persistToRedis(labelName: string, h: LabelHealth): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    const key = `xxb:sg:health:${labelName}`;
    await redis.hmset(key, {
      healthy: h.healthy ? '1' : '0',
      latencies: JSON.stringify(h.latencies.slice(-10)),
      errorCount: String(h.errorCount),
      successCount: String(h.successCount),
      lastUsed: String(h.lastUsed),
    });
    await redis.expire(key, 86400);
  } catch {
    // no-op
  }
}

async function loadFromRedis(): Promise<void> {
  try {
    const redis = getRedis();
    if (!redis) return;
    const keys = await redis.keys('xxb:sg:health:*');
    for (const key of keys) {
      const labelName = key.replace('xxb:sg:health:', '');
      const data = await redis.hgetall(key);
      if (!data || !data.latencies) continue;
      let lats: number[];
      try { lats = JSON.parse(data.latencies); } catch { continue; }
      memoryHealth.set(labelName, {
        healthy: data.healthy === '1',
        latencies: Array.isArray(lats) ? lats : [],
        errorCount: parseInt(data.errorCount ?? '0', 10),
        successCount: parseInt(data.successCount ?? '0', 10),
        lastUsed: parseInt(data.lastUsed ?? '0', 10),
      });
    }
  } catch {
    // no-op
  }
}

// ─── Auto-Assign ────────────────────────────────────────────────────────────

type Tier = 'high' | 'medium' | 'low';

interface UsageProfile {
  /** 最低可接受 tier(含): high=只要 high, medium=medium+high, low=全部。 */
  minTier: Tier;
  /** vision=true 时只保留 capabilities.vision !== false 的 label。 */
  vision: boolean;
  /**
   * video=true 时**只保留 capabilities.video === true 的 label**。
   *
   * 和 vision 的判定方向相反，是故意的：vision 是"没声明就照发"（多数 provider
   * 没声明过，一刀切排除会把池子清空）；video 是"没声明就不要"——因为
   * "返回 200"不等于"看得懂视频"。实测 step-3.7-flash 收下 video_url part、
   * 回 200、content 为空（token 全烧在 reasoning 上，finish_reason=length）。
   * 不显式声明 true 的供应商进 video 链，结果是静默拿到空正文。
   */
  video: boolean;
  /** 链长度(主+备)。 */
  count: number;
}

/**
 * usage → 需求模板。count 宁多勿少:smart group 会按健康度过滤,
 * 池子小时自动降级;池子大时多给几个 backup 无成本(只在前面挂时才会往后走)。
 */
const USAGE_PROFILES: Record<string, UsageProfile> = {
  reply:       { minTier: 'high',   vision: false, video: false, count: 5 },
  reply_pro:   { minTier: 'high',   vision: false, video: false, count: 5 },
  judge:       { minTier: 'medium', vision: false, video: false, count: 4 },
  summarize:   { minTier: 'medium', vision: false, video: false, count: 4 },
  vision:      { minTier: 'medium', vision: true,  video: false, count: 3 },
  audio:       { minTier: 'medium', vision: false, video: false, count: 2 },
  deep_think:  { minTier: 'high',   vision: false, video: false, count: 3 },
  reflection:  { minTier: 'medium', vision: false, video: false, count: 3 },
  mundo:       { minTier: 'high',   vision: false, video: false, count: 2 },
  // 视频理解（2026-09-21）：count=2 就够——真能看的供应商本来就少，
  // 凑长度只会把不能看的塞进来。
  video:       { minTier: 'medium', vision: false, video: true,  count: 2 },
};

const DEFAULT_PROFILE: UsageProfile = { minTier: 'medium', vision: false, video: false, count: 3 };

const TIER_RANK: Record<Tier, number> = { high: 2, medium: 1, low: 0 };

export function isAutoAssignEnabled(): boolean {
  const cfg = getConfig();
  return cfg.enabled && cfg.autoAssign;
}

/**
 * 从全量 provider 池给 usage 自动选 top-N label 链(首元素=主)。
 * 过滤: tier >= profile.minTier;vision profile 要 vision-capable;剔除 unhealthy。
 * 排序: 按当前 strategy(best-latency 用滑窗均延,cost-first 用成本,rr 用最近使用)。
 * 无任何符合时返回 [](调用方应回退到 .env 手动链或默认值)。
 */
export async function smartGroupAutoAssign(usageName: string): Promise<string[]> {
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.autoAssign) return [];

  const { getLabels } = await import('./labels.js');
  const labels = getLabels();
  if (labels.size === 0) return [];

  const profile = USAGE_PROFILES[usageName] ?? DEFAULT_PROFILE;

  const candidates: { name: string; label: AILabel; tier: Tier }[] = [];
  for (const [name, label] of labels.entries()) {
    const tier: Tier = label.tier ?? 'medium';
    if (TIER_RANK[tier] < TIER_RANK[profile.minTier]) continue;
    // vision 现在和 video 同向：**没声明 true 的一律排除**。
    //
    // 2026-09-21 改。旧写法是 `=== false`（只排除显式声明不支持 vision 的），
    // 理由是"未声明的也许还能用，别一棍子打死"。实测这个宽松策略的代价：
    // `Vision failed, returning placeholder` 一天 434 次，图片只拿到占位符
    // `[图片]`——bot 知道有图，不知道图里是什么。
    //
    // 病因是链里塞进了文本 label：vision 链实测排出来是
    // `spark13(未声明) / stepfunthink(未声明) / step5(vision=true)`，
    // 前两个根本不能读图，每次图片调用都先白烧两跳。
    // 宽松策略只在"能看图的 provider 很少"时才划得来；现在池子里有 7 个
    // 声明 vision=true 的 label（含 stepfunvision / step5 两个健康的），
    // 没有短缺，宽松就只剩成本。
    if (profile.vision && label.capabilities?.vision !== true) continue;
    // video：没声明 true 的一律排除（理由见 UsageProfile.video）。
    if (profile.video && label.capabilities?.video !== true) continue;
    candidates.push({ name, label, tier });
  }
  if (candidates.length === 0) return [];

  const known = knownLatencies(candidates);
  const newcomerLatency = medianOf(known);

  const scored = candidates.map(({ name, label }) => {
    const h = memoryHealth.get(name);
    const unhealthy = h !== undefined && !h.healthy;

    switch (cfg.strategy) {
      case 'best-latency': {
        // 不健康: 不参与延迟排序,直接压到所有健康候选之后;
        // 不健康之间按 errorCount 升序(错少的相对更可能恢复)。
        // 语义保留: 全病时仍能排出一个相对最好的,而不是返回空链。
        if (unhealthy) {
          return { name, score: -1_000_000 - (h?.errorCount ?? 0) };
        }
        const avgLat = h && h.latencies.length > 0
          ? h.latencies.reduce((a, b) => a + b, 0) / h.latencies.length
          : newcomerLatency; // 无数据 → 池子中位数,否则新 provider 永远排不上
        // 从未成功过的 label 排到所有**有实测**的之后。
        //
        // 2026-09-21 加。病因：`healthy` 的语义是"熔断器没跳"（errorCount < 5），
        // 不是"这东西能用"。一个 label 初始就是 healthy=true / successCount=0，
        // 试过一两次失败也还是 healthy —— 于是它和真能用的 label 拿同一个
        // 新来者中位数分，平起平坐，甚至因为延迟低而排到前面。
        //
        // 实测：`dsv4flash`（指向 127.0.0.1:3000，那个端口上什么都没有）在
        // health ledger 里是 `healthy=1 succ=0 err=3`，照样进 judge 链第二位。
        // `grok45` 同样 `healthy=1 succ=0`。
        //
        // 做法不是改 healthy（它确实只管熔断），而是给"零成功"一个明确的低分：
        // 比池子里最慢的实测 label 还慢。第一次成功之后就自动归位——
        // 新 provider 仍然进得来，只是要先用一次成功证明自己。
        if (h && h.successCount === 0 && known.length > 0) {
          const slowest = Math.max(...known);
          return { name, score: -(slowest + newcomerLatency) };
        }
        return { name, score: -avgLat };
      }
      case 'cost-first': {
        const costOrder: Record<string, number> = { free: 0, grouped: 1, paid: 2 };
        const cost = inferCost(label.endpoint);
        let score = -(costOrder[cost] ?? 2) * 1000;
        if (unhealthy) score -= 100_000;
        return { name, score };
      }
      case 'round-robin': {
        const lastUsed = h?.lastUsed ?? 0;
        // 最久没用的排前(lastUsed 小 → score 大)
        let score = -lastUsed;
        if (unhealthy) score -= 100_000;
        return { name, score };
      }
      default:
        return { name, score: unhealthy ? -100_000 : 0 };
    }
  });

  scored.sort((a, b) => b.score - a.score);
  const ranked = scored.map((s) => s.name);
  if (!cfg.diversifyUpstream) return ranked.slice(0, profile.count);
  return diversifyByUpstream(ranked, profile.count, labels);
}

/**
 * 链的**上游去重**：同一个 (endpoint, apiKey) 只先取一个，剩下的名额再按分数补。
 *
 * 2026-09-21 加。起因是一次故障归因：心流失败 64% 是 "All labels exhausted"，
 * 而健康 label 里 **stepfun / stepfunjudge / stepfunthink / stepfunvision 四个
 * 共用同一个 endpoint + 同一个 key**（都是 StepFun 的 step_plan/v1 + 4QeT2Y7…）。
 * 按延迟排序时这四个会连排在一起，于是：
 *   · 账号级限流/维护 → 四个 label 同时死 → 链上瞬间一个不剩
 *   · 而真正独立的 step5（另一个 key）和 spark13（另一个 endpoint）排在后面，
 *     常常被挤出 count 名额
 * 日志实测stepfun 系四个 label 的失败是成片出现的（Empty response 1481/685/583/133）。
 *
 * 去重后同样名额拿到的是**不同上游**：这个账号挂了，剩下的还在。
 * 全健康时代价只是排序不同，没有额外成本。
 *
 * 上游 key 相同的 label 仍然全部保留在池子里（轮询/比较时还能用），
 * 这里只影响"同一条链里带谁"。
 */
function diversifyByUpstream(
  ranked: string[],
  count: number,
  labels: Map<string, AILabel>,
): string[] {
  if (count <= 0 || ranked.length <= 1) return ranked.slice(0, Math.max(0, count));
  const seen = new Set<string>();
  const firstPass: string[] = [];
  const rest: string[] = [];
  for (const name of ranked) {
    const l = labels.get(name);
    const upstream = l ? `${l.endpoint}|${(l.apiKeys[0] ?? '').slice(-8)}` : `name:${name}`;
    if (seen.has(upstream)) {
      rest.push(name);
      continue;
    }
    seen.add(upstream);
    firstPass.push(name);
  }
  const out = [...firstPass, ...rest];
  return out.slice(0, count);
}

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initSmartGroup(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.enabled) return;
  await loadFromRedis();
  logProviderHealthSummary();
}

/**
 * 启动时把 provider 池的健康状况打成一行为。
 *
 * 为什么需要：2026-09-21 发现 `.env` 里 **23 个 provider 指向
 * `http://127.0.0.1:3000/v1`，而那个端口上什么都没有**（真正的 relay 在 8317，
 * key 也不一样）。这些 label 在 Redis 里的健康记录全是 `healthy=0 / succ=0`——
 * **一个都没成功过**。而 auto-assign 只是把它们压到链尾，bot 照常靠剩下的
 * provider 干活，于是这个故障可以静默存在很久。
 *
 * "开了但没跑"和"配了但连不上"是同一类问题：都需要有人喊一声。这行日志就是那一声。
 */
function logProviderHealthSummary(): void {
  try {
    const healthy: string[] = [];
    const neverSucceeded: string[] = [];
    const recovering: string[] = [];
    for (const [name, h] of memoryHealth.entries()) {
      if (h.successCount === 0) neverSucceeded.push(name);
      else if (!h.healthy) recovering.push(name);
      else healthy.push(name);
    }
    if (neverSucceeded.length === 0 && recovering.length === 0) {
      logger.info({ healthy: healthy.length }, 'Smart group: all known providers healthy');
      return;
    }
    logger.warn(
      {
        healthy: healthy.length,
        neverSucceeded: neverSucceeded.length,
        neverSucceededList: neverSucceeded.slice(0, 30),
        recovering: recovering.length,
      },
      neverSucceeded.length > 0
        ? 'Smart group: providers with ZERO successful calls — check endpoint/key in .env ' +
          '(they still get deprioritized, not removed, so the bot keeps working via the rest)'
        : 'Smart group: some providers are in cooldown after errors',
    );
  } catch {
    /* 日志永不拦启动 */
  }
}
