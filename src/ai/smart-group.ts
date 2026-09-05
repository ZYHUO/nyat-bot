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
}

const DEFAULT_CONFIG: SmartGroupConfig = {
  enabled: false,
  strategy: 'best-latency',
  windowSize: 10,
  rrIntervalSec: 300,
  autoAssign: false,
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
  };
}

// ─── Cost Inference ─────────────────────────────────────────────────────────

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
          : 9999;
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
  /** 链长度(主+备)。 */
  count: number;
}

/**
 * usage → 需求模板。count 宁多勿少:smart group 会按健康度过滤,
 * 池子小时自动降级;池子大时多给几个 backup 无成本(只在前面挂时才会往后走)。
 */
const USAGE_PROFILES: Record<string, UsageProfile> = {
  reply:       { minTier: 'high',   vision: false, count: 5 },
  reply_pro:   { minTier: 'high',   vision: false, count: 5 },
  judge:       { minTier: 'medium', vision: false, count: 4 },
  summarize:   { minTier: 'medium', vision: false, count: 4 },
  vision:      { minTier: 'medium', vision: true,  count: 3 },
  audio:       { minTier: 'medium', vision: false, count: 2 },
  deep_think:  { minTier: 'high',   vision: false, count: 3 },
  reflection:  { minTier: 'medium', vision: false, count: 3 },
  mundo:       { minTier: 'high',   vision: false, count: 2 },
};

const DEFAULT_PROFILE: UsageProfile = { minTier: 'medium', vision: false, count: 3 };

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
    if (profile.vision && label.capabilities?.vision === false) continue;
    candidates.push({ name, label, tier });
  }
  if (candidates.length === 0) return [];

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
          : 5_000; // 无数据给中间值,让新 provider 有机会被试
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
  return scored.slice(0, profile.count).map((s) => s.name);
}

// ─── Init ───────────────────────────────────────────────────────────────────

export async function initSmartGroup(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.enabled) return;
  await loadFromRedis();
}
