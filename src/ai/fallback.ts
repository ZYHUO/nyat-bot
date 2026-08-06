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

    // per-label 覆盖:给慢/推理模型(如 mundo,回复链里需几分钟 + 大 maxTokens 防
    // 推理截断成空)单独放宽,而不动 usage 配置(正常回复的快模型照旧 60s/小 maxTokens)。
    // 超时仍受调用方 maxTimeoutMs 上限约束(heart/gate 等延迟敏感路径设了 maxTimeoutMs
    // → 即便落到 mundo 也不会久等,会按上限超时后继续 fallback)。
    const attemptOpts = attemptOptsFor(label, callOpts, options.maxTimeoutMs);

    try {
      // Hedged request: if this is the primary and there's a backup,
      // race with a delayed backup call.
      // Note: hedgeTriedLabel is set before the call. If hedgedCall throws,
      // both primary and hedge have been attempted, so skipping the hedge
      // label in the fallback loop is correct.
      if (i === 0 && labelNames.length > 1 && hedgeDelayMs > 0) {
        hedgeTriedLabel = labelNames[1]!;
        const hedgeLabel = getLabel(hedgeTriedLabel);
        const result = await hedgedCall(
          label, hedgeLabel, options.messages, callOpts, hedgeDelayMs, cooldown,
          options.rejectEmpty ?? false, options.maxTimeoutMs,
          options.usage, options.suppressMetrics ?? false, options.chatId,
        );
        // rejectEmpty 已在 hedgedCall 内对两跳都施加;这里再兜一层,空则落到下个 backup。
        if (options.rejectEmpty && !result.content.trim()) {
          throw new AIError('Empty response', labelName, label.model, 'AI_EMPTY');
        }
        if (!options.suppressMetrics) emitLlmResult(options.usage, result, options.chatId);
        return result;
      }

      const result = await callModel(label, options.messages, attemptOpts);
      if (options.rejectEmpty && !result.content.trim()) {
        throw new AIError('Empty response', labelName, label.model, 'AI_EMPTY');
      }
      // 成功 → 重置熔断失败计数
      await cooldown.recordSuccess(label.model);
      // 观测:落到 backup(主模型失败/被拒后换的第 i 跳)成功时记 label+usage+耗时,
      // 便于盯 fallback 命中(尤其回复链里 mundo)与其真实耗时。只在 fallback 时打。
      if (i > 0) {
        logger.info(
          { usage: options.usage, label: labelName, model: label.model, attempt: i, latencyMs: result.latencyMs },
          'Fallback label used',
        );
      }
      if (!options.suppressMetrics) emitLlmResult(options.usage, result, options.chatId);
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

      // Content safety rejection — **继续试下一个 provider**,不再一拒就放弃整条链。
      if (err instanceof AIError && err.code === 'AI_CONTENT_REJECTED') {
        logger.warn({ label: labelName, err: err.message }, 'Content rejected by safety filter, trying next provider');
      }

      // 429 → 短期冷却
      if (err instanceof AIError && err.code === 'AI_RATE_LIMIT') {
        await cooldown.setCooldown(label.model);
      }

      // 所有失败类型 → 熔断器记录（429 已有短期冷却，也记一笔加速熔断）
      const errCode = err instanceof AIError ? err.code : 'AI_UNKNOWN';
      const tripped = await cooldown.recordFailure(label.model, errCode);
      if (tripped) {
        const remaining = await cooldown.getRemainingSeconds(label.model);
        logger.warn({ label: labelName, model: label.model, errCode, breakerSec: remaining }, 'Circuit breaker tripped');
      }

      // Metrics: this attempt failed (visible per-label so retries/429 storms show up).
      if (!options.suppressMetrics) emitLlmError(options.usage, labelName, label.model, options.chatId);
      logger.warn({ label: labelName, err: errors.at(-1)?.message }, 'Label failed, trying next');
    }
  }

  const lastErr = errors.at(-1);
  throw lastErr ?? new AIError('All labels exhausted', 'unknown', 'unknown', 'AI_ALL_FAILED');
}

/** 单跳尝试参数:给有 per-label timeout/maxTokens 覆盖的 label 套上(顺序 fallback 与
 *  hedge 共用同一逻辑,修 codex #1:原来 hedge 直接用 callOpts、丢了 per-label 覆盖)。 */
function attemptOptsFor(
  label: ReturnType<typeof getLabel>,
  callOpts: { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal },
  maxTimeoutMs: number | undefined,
): { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal } {
  if (label.timeout === undefined && label.maxTokens === undefined) return callOpts;
  return {
    ...callOpts,
    timeout: label.timeout === undefined
      ? callOpts.timeout
      : (maxTimeoutMs !== undefined ? Math.min(label.timeout, maxTimeoutMs) : label.timeout),
    maxTokens: label.maxTokens ?? callOpts.maxTokens,
  };
}

async function hedgedCall(
  primaryLabel: ReturnType<typeof getLabel>,
  hedgeLabel: ReturnType<typeof getLabel>,
  messages: AICallOptions['messages'],
  callOpts: { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal },
  hedgeDelayMs: number,
  cooldown: CooldownTracker,
  rejectEmpty: boolean,
  maxTimeoutMs: number | undefined,
  usage: string,
  suppressMetrics: boolean,
  chatId: number | undefined,
): Promise<AICallResult> {
  const toError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

  // 每一跳一个自己的 AbortController,并把调用方的 signal 合进去。
  //
  // 原实现只用 clearTimeout 取消 hedge —— 那只在"主标签 2s 内先完成"时有效。定时器一旦
  // 触发、hedge 的 fetch 已经发出,主标签随后胜出时 Promise.any 直接返回,**没有任何东西
  // 去掐掉 hedge 的请求**:它会跑到底并被 provider 完整计费。而 HEDGE_DELAY_MS 默认 2000,
  // 回复链主模型(grok-4.5, REASONING=low)的延迟远高于 2s,heart 判定也在 2-6s ——
  // 这不是边缘情况,是几乎每次都命中,等于整条链的 token 账单翻倍。
  const controllers = new Map<string, AbortController>();
  let settledWinner: string | null = null;
  const abortLosers = (winner: string | null) => {
    for (const [name, ac] of controllers) {
      if (name !== winner) ac.abort(new Error('hedge lost the race'));
    }
  };

  // 单跳:用该 label 自己的 attemptOpts(修 #1:per-label timeout/maxTokens 覆盖);
  // rejectEmpty 时空内容视为失败**在这里 reject**(修 #1:否则 Promise.any 把空当成功,
  // heart/gate 解析失败 → fail-open pass → 吞回复)。
  const attempt = (label: ReturnType<typeof getLabel>): Promise<AICallResult> => {
    const ac = new AbortController();
    controllers.set(label.name, ac);
    const opts = attemptOptsFor(label, callOpts, maxTimeoutMs);
    const signal = callOpts.signal
      ? AbortSignal.any([callOpts.signal, ac.signal])
      : ac.signal;
    return callModel(label, messages, { ...opts, signal }).then((r) => {
      // abort 之前就已经完成的输家(两跳几乎同时返回)仍然被 provider 计费过。原实现让
      // 它的 rejection/resolution 被 Promise.any 吞掉,既不 emitLlmResult 也不 emitLlmError
      // —— 于是 llm_token_daily 与 llm_tokens_total 系统性少算了 hedge 那一份,
      // 这也正是"hedge 不取消输家"能长期没被发现的原因。这里把它记成 discarded。
      if (settledWinner !== null && settledWinner !== label.name && !suppressMetrics) {
        emitLlmResult(usage, r, chatId);
        logger.info(
          { usage, label: label.name, tokens: r.tokenUsage.total },
          'Hedge loser completed anyway — tokens billed, counted as discarded',
        );
      }
      if (rejectEmpty && !r.content.trim()) {
        throw new AIError('Empty response', label.name, label.model, 'AI_EMPTY');
      }
      return r;
    });
  };

  // Wrap each call to handle rate-limit cooldown side-effects and normalize errors
  const primaryPromise = attempt(primaryLabel).catch((err: unknown) => {
    if (err instanceof AIError && err.code === 'AI_RATE_LIMIT') {
      void cooldown.setCooldown(primaryLabel.model);
    }
    // 熔断记录
    const errCode = err instanceof AIError ? err.code : 'AI_UNKNOWN';
    void cooldown.recordFailure(primaryLabel.model, errCode).then((tripped) => {
      if (tripped) logger.warn({ label: primaryLabel.name, model: primaryLabel.model, errCode }, 'Circuit breaker tripped (hedge primary)');
    });
    return Promise.reject(toError(err));
  });

  // After hedgeDelayMs, start hedge if primary hasn't resolved yet and hedge isn't cooling down
  let hedgeStarted = false;
  const hedgePromise = new Promise<AICallResult>((resolve, reject) => {
    const timer = setTimeout(async () => {
      if (await cooldown.isCoolingDown(hedgeLabel.model)) {
        reject(new AIError('Hedge skipped (cooldown)', 'unknown', 'unknown', 'AI_HEDGE_FAILED'));
        return;
      }
      hedgeStarted = true;
      attempt(hedgeLabel).then((r) => {
        void cooldown.recordSuccess(hedgeLabel.model);
        return r;
      }).then(resolve, (err: unknown) => {
        // 2026-08-07 事故修复:hedge 输掉 race 被 abort 不是真实故障,不计熔断。
        // 原实现把输家的 abort 也 recordFailure —— k27code "Empty response"(真故障)
        // + hedge 输家 timeout(无辜)双杀,把熔断退避刷到 405s+,冻死 summarize 链,
        // deep-reflection 12 群全灭。settledWinner 非空说明已有赢家,hedge 是被掐掉的。
        if (settledWinner === null || settledWinner === hedgeLabel.name) {
          if (err instanceof AIError && err.code === 'AI_RATE_LIMIT') void cooldown.setCooldown(hedgeLabel.model);
          const errCode = err instanceof AIError ? err.code : 'AI_UNKNOWN';
          void cooldown.recordFailure(hedgeLabel.model, errCode).then((tripped) => {
            if (tripped) logger.warn({ label: hedgeLabel.name, model: hedgeLabel.model, errCode }, 'Circuit breaker tripped (hedge backup)');
          });
        }
        reject(toError(err));
      });
    }, hedgeDelayMs);

    // If primary resolves before the timer fires, cancel the hedge
    primaryPromise.then(() => clearTimeout(timer), () => { /* let timer fire */ });
  });

  // Return whichever succeeds first; only reject if both fail
  return Promise.any([primaryPromise, hedgePromise])
    .then((r) => {
      // 赢家返回前先掐掉输家在飞的请求 —— 否则它跑到底并被计费。
      settledWinner = r.label;
      abortLosers(r.label);
      // 赢家成功 → 只重置赢家自己的熔断失败计数
      // (primary 失败但 hedge 赢时，primary 的计数不应被重置 — 否则永远不熔断)
      if (r.label === primaryLabel.name) void cooldown.recordSuccess(primaryLabel.model);
      if (r.label === hedgeLabel.name) void cooldown.recordSuccess(hedgeLabel.model);
      if (hedgeStarted) {
        logger.info(
          { winner: r.label, primary: primaryLabel.name, hedge: hedgeLabel.name },
          'Hedge raced; loser aborted',
        );
      }
      return r;
    })
    .catch((err: unknown) => {
      abortLosers(null);
      if (err instanceof AggregateError && err.errors.length > 0) {
        throw err.errors[0];
      }
      throw err;
    });
}
