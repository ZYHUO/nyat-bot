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
 * True when the signal aborted due to a CALLER decision(turn 打断/进程
 * 关机),NOT a timeout/网络层中断。**白名单**判定:只有 abort-registry
 * 打出的 `TurnInterrupt` 和 shutdown 契约打出的 `Shutdown` reason 才算
 * caller abort(跳过 fallback 链);TimeoutError、裸 AbortError、网络
 * teardown 等一律走正常错误路径,保留 fallback 重试
 * (review-workflow:blocklist→allowlist)。
 */
export function isCallerAbort(signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === 'TurnInterrupt' || reason?.name === 'Shutdown';
}
