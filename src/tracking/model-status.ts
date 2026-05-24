// ────────────────────────────────────────
// ModelStatusClassifier — pure function
// Port of PHP ModelStatusClassifier
// ────────────────────────────────────────

import type { ModelStatus } from './types.js';

export function classifyModelStatus(
  httpCode: number,
  fetchError: string,
  latencyMs: number,
  responseBody = '',
): ModelStatus {
  if (fetchError || httpCode === 0) {
    return { status: 'down', latencyMs };
  }

  if (httpCode === 429) {
    if (isLongCooldown(responseBody) || latencyMs < 50) {
      return { status: 'down', latencyMs };
    }
    return { status: 'slow', latencyMs };
  }

  if (httpCode >= 400) return { status: 'down', latencyMs };
  if (latencyMs > 15000) return { status: 'down', latencyMs };
  if (latencyMs > 5000) return { status: 'slow', latencyMs };

  return { status: 'up', latencyMs };
}

function isLongCooldown(body: string): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = (parsed.error ?? parsed) as Record<string, unknown>;
    if (error.code === 'model_cooldown') {
      const resetSeconds = Number(error.reset_seconds);
      return Number.isFinite(resetSeconds) && resetSeconds > 120;
    }
  } catch {
    /* ignore */
  }
  return false;
}
