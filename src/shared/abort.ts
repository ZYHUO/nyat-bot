// ────────────────────────────────────────
// AbortSignal 工具 — turn-actor 打断通路的基础
// ────────────────────────────────────────
//
// 合并"超时信号"与"外部打断信号"为一个 signal 传入 fetch / AI SDK,
// 让超时和用户新消息打断都能真正中止底层请求(而不是 Promise.race 弃单)。

/**
 * Merge an optional timeout with optional external signals into one AbortSignal.
 * Returns undefined when nothing to merge (so callers can pass it straight through).
 */
export function mergeAbortSignals(
  timeoutMs?: number,
  ...externals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (timeoutMs && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  for (const s of externals) {
    if (s) signals.push(s);
  }
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/** True when the error (of any shape) represents an abort of the given signal. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError' || /\baborted?\b/i.test(err.message);
  }
  return false;
}

/**
 * True when the signal aborted due to a CALLER decision(turn 打断),
 * NOT a timeout. AbortSignal.timeout() aborts with reason.name ===
 * 'TimeoutError';外部打断用 controller.abort(new Error(...))。
 * 合并信号(mergeAbortSignals)的 reason 来自先触发的那个 —— 这样
 * 超时不会被误判成打断而跳过 fallback 链(codex review)。
 */
export function isCallerAbort(signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name !== 'TimeoutError';
}
