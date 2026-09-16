// ────────────────────────────────────────
// Model 路由 — usage → ModelTier 映射
// ────────────────────────────────────────

import { ModelTier } from './types.js';

const USAGE_TIER_MAP: Record<string, ModelTier> = {
  judge: ModelTier.M1_MICRO,
  reply: ModelTier.M2_FAST,
  vision: ModelTier.M3_MAIN,
  summarize: ModelTier.M1_MICRO,
};

export function getTierForUsage(usage: string): ModelTier {
  return USAGE_TIER_MAP[usage] ?? ModelTier.M2_FAST;
}
