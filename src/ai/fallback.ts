// ────────────────────────────────────────
// Fallback chain + hedged request
// ────────────────────────────────────────

import type { AICallOptions, AICallResult } from './types.js';
import { callModel } from './provider.js';
import { getUsage, getLabel } from './labels.js';
import { emitLlmResult, emitLlmError } from './events.js';
import { CooldownTracker } from './cooldown.js';
import { AIError } from '../shared/errors.js';
import { isCallerAbort } from '../shared/abort.js';
import { logger } from '../shared/logger.js';
import { getRedis } from '../db/redis.js';
import { env } from '../env.js';

export async function callWithFallback(options: AICallOptions): Promise<AICallResult> {
  const usage = getUsage(options.usage);
  const labelNames = [usage.label, ...usage.backups];
  const cooldown = new CooldownTracker(getRedis());
  const hedgeDelayMs = env().HEDGE_DELAY_MS;

  const callOpts = {
    maxTokens: options.maxTokens ?? usage.maxTokens,
    temperature: options.temperature ?? usage.temperature,
    // Per-attempt budget: callModel turns this into a FRESH AbortSignal.timeout
    // for each attempt. maxTimeoutMs lets latency-bounded callers (heart/gate)
    // cap every attempt without baking a shared timeout signal into
    // options.signal (which would poison all backups once it fires).
    timeout: options.maxTimeoutMs !== undefined
      ? Math.min(usage.timeout, options.maxTimeoutMs)
      : usage.timeout,
    signal: options.signal,
    jsonMode: options.jsonMode,
  };

  const errors: Error[] = [];
  let hedgeTriedLabel: string | undefined;

  for (let i = 0; i < labelNames.length; i++) {
    const labelName = labelNames[i]!;

    // Skip label already tried as a hedge
    if (labelName === hedgeTriedLabel) continue;

    const label = getLabel(labelName);

    // Skip if cooling down
    if (await cooldown.isCoolingDown(label.model)) {
      logger.debug({ label: labelName, model: label.model }, 'Skipping cooled-down model');
      continue;
    }

    try {
      // Hedged request: if this is the primary and there's a backup,
      // race with a delayed backup call.
      // Note: hedgeTriedLabel is set before the call. If hedgedCall throws,
      // both primary and hedge have been attempted, so skipping the hedge
      // label in the fallback loop is correct.
      if (i === 0 && labelNames.length > 1 && hedgeDelayMs > 0) {
        hedgeTriedLabel = labelNames[1]!;
        const hedgeLabel = getLabel(hedgeTriedLabel);
        const result = await hedgedCall(label, hedgeLabel, options.messages, callOpts, hedgeDelayMs, cooldown);
        if (!options.suppressMetrics) emitLlmResult(options.usage, result);
        return result;
      }

      const result = await callModel(label, options.messages, callOpts);
      if (options.rejectEmpty && !result.content.trim()) {
        throw new AIError('Empty response', labelName, label.model, 'AI_EMPTY');
      }
      if (!options.suppressMetrics) emitLlmResult(options.usage, result);
      return result;
    } catch (err) {
      errors.push(err instanceof Error ? err : new Error(String(err)));

      // External abort (turn interrupt) — don't fallback, surface immediately.
      // 按 reason 区分:超时引发的 abort(TimeoutError)继续走 fallback 链。
      if (isCallerAbort(options.signal)) {
        throw err instanceof AIError && err.code === 'AI_ABORTED'
          ? err
          : new AIError('Aborted by caller', labelName, label.model, 'AI_ABORTED');
      }

      // Content safety rejection — don't fallback, throw immediately
      if (err instanceof AIError && err.code === 'AI_CONTENT_REJECTED') {
        logger.warn({ label: labelName, err: err.message }, 'Content rejected by safety filter');
        throw err;
      }

      // Set cooldown on 429
      if (err instanceof AIError && err.code === 'AI_RATE_LIMIT') {
        await cooldown.setCooldown(label.model);
      }

      // Metrics: this attempt failed (visible per-label so retries/429 storms show up).
      if (!options.suppressMetrics) emitLlmError(options.usage, labelName, label.model);
      logger.warn({ label: labelName, err: errors.at(-1)?.message }, 'Label failed, trying next');
    }
  }

  const lastErr = errors.at(-1);
  throw lastErr ?? new AIError('All labels exhausted', 'unknown', 'unknown', 'AI_ALL_FAILED');
}

async function hedgedCall(
  primaryLabel: ReturnType<typeof getLabel>,
  hedgeLabel: ReturnType<typeof getLabel>,
  messages: AICallOptions['messages'],
  callOpts: { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal },
  hedgeDelayMs: number,
  cooldown: CooldownTracker,
): Promise<AICallResult> {
  const toError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

  // Wrap each call to handle rate-limit cooldown side-effects and normalize errors
  const primaryPromise = callModel(primaryLabel, messages, callOpts).catch((err: unknown) => {
    if (err instanceof AIError && err.code === 'AI_RATE_LIMIT') {
      void cooldown.setCooldown(primaryLabel.model);
    }
    return Promise.reject(toError(err));
  });

  // After hedgeDelayMs, start hedge if primary hasn't resolved yet and hedge isn't cooling down
  const hedgePromise = new Promise<AICallResult>((resolve, reject) => {
    const timer = setTimeout(async () => {
      if (await cooldown.isCoolingDown(hedgeLabel.model)) {
        reject(new AIError('Hedge skipped (cooldown)', 'unknown', 'unknown', 'AI_HEDGE_FAILED'));
        return;
      }
      callModel(hedgeLabel, messages, callOpts).then(resolve, (err: unknown) => reject(toError(err)));
    }, hedgeDelayMs);

    // If primary resolves before the timer fires, cancel the hedge
    primaryPromise.then(() => clearTimeout(timer), () => { /* let timer fire */ });
  });

  // Return whichever succeeds first; only reject if both fail
  return Promise.any([primaryPromise, hedgePromise]).catch((err: unknown) => {
    if (err instanceof AggregateError && err.errors.length > 0) {
      throw err.errors[0];
    }
    throw err;
  });
}
