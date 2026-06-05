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
