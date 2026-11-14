// Independent from bot construction/logger dependencies; owns the actual loop,
// not merely grammY's network polling flag.
let running: Promise<void> | undefined;
let scope: AbortController | undefined;
export function ownBotPolling(start: (signal: AbortSignal) => Promise<void>): Promise<void> {
  if (running) throw new Error('polling_already_owned');
  scope = new AbortController();
  running = start(scope.signal);
  return running;
}
export function cancelBotPollingRetries(): void { scope?.abort(); }
export async function drainBotPolling(): Promise<void> {
  cancelBotPollingRetries();
  try { await running; }
  finally { running = undefined; scope = undefined; }
}
