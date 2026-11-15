import type { AILabel, AIProviderOptions } from './types.js';
import { AIError } from '../shared/errors.js';

export const STRICT_AI_MAX_REQUESTS = 2;
export const STRICT_AI_MAX_TOKENS = 1200;
export const STRICT_AI_DEADLINE_MS = 45_000;

export function requestBudgetError(code: 'DENIED' | 'EXHAUSTED' | 'DEADLINE'): AIError {
  return new AIError(`Strict provider request budget: ${code.toLowerCase()}`, 'budget', 'budget', `AI_REQUEST_BUDGET_${code}`);
}
/** The SDK may wrap a fetch error. Preserve a budget denial across that boundary. */
export function strictBudgetError(error: unknown): AIError | null {
  for (let depth = 0; depth < 8 && error && typeof error === 'object'; depth++) {
    if (error instanceof AIError && error.code.startsWith('AI_REQUEST_BUDGET_')) return error;
    error = 'cause' in error ? error.cause : undefined;
  }
  return null;
}
export function strictMaxTokens(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(STRICT_AI_MAX_TOKENS, Math.floor(value))) : STRICT_AI_MAX_TOKENS;
}
export function assertBudgetAlive(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw requestBudgetError('DEADLINE');
}
/** Stop waiting on storage/metadata too; late completion must not start a request. */
export function withinBudgetSignal<T>(operation: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(requestBudgetError('DEADLINE'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** All strict paths use this immediately at fetch, including the actual SDK fetch.
 * A redirect would be a second unmetered network request, so it is refused. */
export async function budgetedProviderFetch(
  _label: AILabel, opts: AIProviderOptions, input: string | URL | Request, init: RequestInit,
): Promise<Response> {
  if (!opts.beforeProviderRequest) return fetch(input, init);
  const signal = init.signal ?? opts.signal;
  assertBudgetAlive(signal);
  try {
    await withinBudgetSignal(Promise.resolve().then(() => {
      assertBudgetAlive(signal);
      return opts.beforeProviderRequest!();
    }), signal);
  } catch (error) {
    throw strictBudgetError(error) ?? requestBudgetError('DENIED');
  }
  assertBudgetAlive(signal);
  return fetch(input, { ...init, signal, redirect: 'error' });
}
