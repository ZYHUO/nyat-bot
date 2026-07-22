// ────────────────────────────────────────
// Model health status check — ping AI endpoints
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { getLabels, getUsage } from '../ai/labels.js';
import { classifyModelStatus } from '../tracking/model-status.js';
import { saveModelStatusSnapshot } from '../admin/model-status.js';
import type { ModelStatusSnapshot } from '../admin/model-status.js';
import { logger } from '../shared/logger.js';

// Map tracking status ('up'|'slow'|'down') to admin snapshot status
function toSnapshotStatus(s: string): 'ok' | 'error' | 'timeout' | 'slow' {
  if (s === 'up') return 'ok';
  if (s === 'slow') return 'slow';
  return 'error';
}

export async function runModelCheck(): Promise<void> {
  const redis = getRedis();

  // Check the primary label for all active usages
  const usageNames = ['reply', 'reply_pro', 'judge', 'vision', 'summarize', 'deep_think'] as const;
  const checked = new Set<string>();

  const snapshot: ModelStatusSnapshot = {
    ts: Math.floor(Date.now() / 1000),
    models: {},
  };

  for (const usageName of usageNames) {
    let usage;
    try { usage = getUsage(usageName); } catch { continue; }
    const labelName = usage.label;
    if (checked.has(labelName)) continue;
    checked.add(labelName);

    const label = getLabels().get(labelName);
    if (!label) continue;

    const start = Date.now();
    let httpCode = 0;
    let error = '';
    let responseBody = '';

    try {
      const isClaude = label.apiFormat === 'claude';
      const endpoint = isClaude
        ? `${label.endpoint}/messages`
        : `${label.endpoint}/chat/completions`;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (isClaude) {
        headers['x-api-key'] = label.apiKeys[0] ?? '';
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['Authorization'] = `Bearer ${label.apiKeys[0] ?? ''}`;
      }
      const body = isClaude
        ? { model: label.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }
        : { model: label.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      httpCode = res.status;
      if (!res.ok) {
        responseBody = await res.text().catch(() => '');
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const latency = Date.now() - start;
    const result = classifyModelStatus(httpCode, error, latency, responseBody);

    // Key by "model (usage)" to differentiate same model used for different usages
    const displayKey = `${label.model}`;
    // If same model is used for multiple usages, keep the first one (already checked)
    if (!snapshot.models[displayKey]) {
      snapshot.models[displayKey] = {
        role: usageName,
        model: label.model,
        status: toSnapshotStatus(result.status),
        latency_ms: latency,
      };
    }
  }

  await saveModelStatusSnapshot(redis, snapshot);
  logger.info({ modelCount: Object.keys(snapshot.models).length }, 'Model check completed');
}
