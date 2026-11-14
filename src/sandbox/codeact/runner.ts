import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import { env } from '../../env.js';
import { codeActLaunchArgs, validateCodeActProfile } from './profile.js';
import type { CodeActProfile } from './profile.js';
import { codeActSeccompFilter } from './seccomp.js';
import { packCodeActValue, unpackCodeActValue, validCapabilityName } from './capabilities.js';
import type { CodeActCapabilities, WireValue } from './capabilities.js';

export interface CodeActRunOptions {
  timeoutMs: number;
  isClosed?: () => boolean;
  onTimeout?: () => void;
}
export interface CodeActRunResult { value: unknown; logs: string[] }
let running = false;
let isolationBlocked = false;
const MAX_WAITING_RUNS = 16;
const TEARDOWN_CONFIRMATION_MS = 1000;
interface WaitingRun {
  deadline: number;
  options: CodeActRunOptions;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  cancellation: ReturnType<typeof setInterval>;
}
const waitingRuns: WaitingRun[] = [];

function cancellationError(options: CodeActRunOptions): Error | undefined {
  try { return options.isClosed?.() ? new Error('codeact_cancelled') : undefined; }
  catch (error) { return error instanceof Error ? error : new Error(String(error)); }
}

function timeoutError(options: CodeActRunOptions): Error {
  try { options.onTimeout?.(); } catch { /* Notification failure cannot keep a queued or running guest alive. */ }
  return new Error('codeact_timeout');
}

function clearWaitingTimers(waiter: WaitingRun): void {
  clearTimeout(waiter.timeout);
  clearInterval(waiter.cancellation);
}

/** One guest per process, shared by Meta and every CodeAct worker. */
function releaseSlot(): void {
  for (let next = waitingRuns.shift(); next; next = waitingRuns.shift()) {
    clearWaitingTimers(next);
    if (isolationBlocked) { next.reject(new Error('codeact_isolation_teardown_unconfirmed')); continue; }
    const error = cancellationError(next.options)
      ?? (Date.now() >= next.deadline ? timeoutError(next.options) : undefined);
    if (error) { next.reject(error); continue; }
    next.resolve(releaseSlot);
    return;
  }
  running = false;
}

function acquireSlot(deadline: number, options: CodeActRunOptions): Promise<() => void> {
  if (isolationBlocked) return Promise.reject(new Error('codeact_isolation_teardown_unconfirmed'));
  const error = cancellationError(options);
  if (error) return Promise.reject(error);
  if (Date.now() >= deadline) return Promise.reject(timeoutError(options));
  if (!running) {
    running = true;
    return Promise.resolve(releaseSlot);
  }
  if (waitingRuns.length >= MAX_WAITING_RUNS) return Promise.reject(new Error('codeact_isolation_queue_full'));
  return new Promise((resolve, reject) => {
    const remove = (failure: Error): void => {
      const index = waitingRuns.indexOf(waiter);
      if (index < 0) return;
      waitingRuns.splice(index, 1);
      clearWaitingTimers(waiter);
      reject(failure);
    };
    const waiter: WaitingRun = {
      deadline, options, resolve, reject,
      timeout: setTimeout(() => remove(timeoutError(options)), Math.max(1, deadline - Date.now())),
      cancellation: setInterval(() => {
        const failure = cancellationError(options);
        if (failure) remove(failure);
      }, 50),
    };
    waitingRuns.push(waiter);
  });
}

/** Profile IO consumes the same request deadline; a late resolution never launches code. */
function validateWithinDeadline(profile: CodeActProfile, deadline: number, options: CodeActRunOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const initialError = cancellationError(options)
      ?? (Date.now() >= deadline ? timeoutError(options) : undefined);
    if (initialError) { reject(initialError); return; }
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(cancellation);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(timeoutError(options)), Math.max(1, deadline - Date.now()));
    const cancellation = setInterval(() => {
      const error = cancellationError(options);
      if (error) finish(error);
    }, 50);
    Promise.resolve().then(() => validateCodeActProfile(profile)).then(
      () => finish(),
      error => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

function validateArgs(value: unknown, depth = 0): void {
  if (depth > 16) throw new Error('capability_arguments_too_deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 1024) throw new Error('capability_array_too_large');
    for (const item of value) validateArgs(item, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 256) throw new Error('capability_object_too_large');
    for (const [key, item] of entries) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('capability_argument_key_denied');
      validateArgs(item, depth + 1);
    }
    return;
  }
  throw new Error('capability_arguments_must_be_json');
}

/**
 * OS-isolated process with a fixed launcher and one-at-a-time explicit RPC.
 * Never substitutes AsyncFunction/vm/worker_threads in the application process.
 * An already-started host action cannot be undone by killing the guest; host
 * APIs still own consent, chat scope and cancellation checks around side effects.
 */
export async function runCodeActSandbox(
  profile: CodeActProfile,
  code: string,
  capabilities: CodeActCapabilities,
  options: CodeActRunOptions,
): Promise<CodeActRunResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('invalid_codeact_timeout');
  if (Buffer.byteLength(code) > 32 * 1024) throw new Error('codeact_source_too_large');
  for (const name of capabilities.keys()) if (!validCapabilityName(name)) throw new Error('invalid_capability_name');
  // Waiting, validation and execution share one total budget. Queueing must not
  // turn a 30-second request into an unbounded wait followed by another 30 seconds.
  const deadline = Date.now() + Math.min(options.timeoutMs, 30_000);
  const release = await acquireSlot(deadline, options);
  try {
    await validateWithinDeadline(profile, deadline, options);
    const error = cancellationError(options)
      ?? (Date.now() >= deadline ? timeoutError(options) : undefined);
    if (error) throw error;
    return await launch(profile, code, capabilities, { ...options, timeoutMs: deadline - Date.now() });
  } finally { release(); }
}

function launch(profile: CodeActProfile, code: string, capabilities: CodeActCapabilities, options: CodeActRunOptions): Promise<CodeActRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(profile.prlimitPath, codeActLaunchArgs(profile, process.getuid?.() === 0), {
      cwd: '/', env: { LANG: 'C.UTF-8', PATH: '/usr/bin:/bin' },
      detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    let finished = false;
    let closed = false;
    let settled = false;
    let completionError: Error | undefined;
    let completionResult: CodeActRunResult | undefined;
    let teardownTimer: ReturnType<typeof setTimeout> | undefined;
    let ready = false;
    let buffer = '';
    let stderr = '';
    let totalBytes = 0;
    let calls = 0;
    let outstanding = 0;
    let queue = Promise.resolve();
    const ids = new Set<number>();
    const timer = setTimeout(() => {
      try { options.onTimeout?.(); } catch { /* Failure to notify must never leave the guest running. */ }
      finish(new Error('codeact_timeout'));
    }, Math.min(options.timeoutMs, 30_000));
    const cancellation = setInterval(() => {
      try {
        if (options.isClosed?.()) finish(new Error('codeact_cancelled'));
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    }, 50);
    function finish(error?: Error, result?: CodeActRunResult): void {
      if (finished) return;
      finished = true;
      completionError = error;
      completionResult = result;
      clearTimeout(timer);
      clearInterval(cancellation);
      child.stdin?.destroy();
      // bubblewrap also has die-with-parent; seccomp denies guest setsid/setpgid
      // and process creation. PID-namespace init teardown reaps any guest threads.
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch { /* The close deadline below fails closed. */ } }
      }
      // A sent SIGKILL is not an exit acknowledgement. Do not launch another
      // guest until close confirms namespace teardown and inherited stdio closure.
      if (closed || !child.pid) settle();
      else teardownTimer = setTimeout(() => {
        isolationBlocked = true; // Fail closed until this bot process restarts.
        completionError = new Error('codeact_isolation_teardown_unconfirmed');
        settle();
      }, TEARDOWN_CONFIRMATION_MS);
    }
    function settle(): void {
      if (settled) return;
      settled = true;
      if (teardownTimer) clearTimeout(teardownTimer);
      if (completionError) reject(completionError);
      else resolve(completionResult ?? { value: undefined, logs: [] });
    }
    function send(message: object): void {
      if (!finished) child.stdin?.write(JSON.stringify(message) + '\n');
    }
    child.on('error', error => finish(new Error(`codeact_isolation_unavailable: ${error.message}`)));
    child.stdin?.on('error', () => { /* Process close/error determines the outcome. */ });
    (child.stdio[3] as Writable).on('error', () => { /* A rejected filter makes bwrap exit, never bypass it. */ });
    (child.stdio[3] as Writable).end(codeActSeccompFilter());
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.on('close', (exitCode, signal) => {
      closed = true;
      if (!finished) finish(new Error(`codeact_isolation_exit: ${exitCode ?? signal}; ${stderr.slice(0, 2000)}`));
      else settle();
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (finished) return;
      totalBytes += Buffer.byteLength(chunk);
      buffer += chunk;
      if (totalBytes > 1024 * 1024 || Buffer.byteLength(buffer) > 128 * 1024) {
        finish(new Error('codeact_output_limit'));
        return;
      }
      let newline: number;
      while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          if (Buffer.byteLength(line) > 64 * 1024) throw new Error('codeact_frame_limit');
          const message = JSON.parse(line) as Record<string, unknown>;
          if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('invalid_codeact_frame');
          if (message['type'] === 'ready') {
            if (ready || !Number.isInteger(message['uid']) || Number(message['uid']) <= 0
              || message['noNewPrivs'] !== true || message['seccomp'] !== true) throw new Error('invalid_codeact_attestation');
            ready = true;
            send({ type: 'run', code, methods: [...capabilities.keys()] });
          } else if (message['type'] === 'call') {
            const { id, method, args } = message;
            if (!ready || !Number.isSafeInteger(id) || Number(id) < 1 || ids.has(Number(id))
              || typeof method !== 'string' || !capabilities.has(method) || !Array.isArray(args)
              || args.length > 12 || ++calls > 32) throw new Error('codeact_capability_denied_or_limit');
            validateArgs(args);
            ids.add(Number(id));
            outstanding++;
            // Serial execution preserves unawaited sendText -> endTask ordering.
            queue = queue.then(async () => {
              if (finished || options.isClosed?.()) return;
              try {
                const result = await capabilities.get(method)!(...args);
                send({ type: 'response', id, ok: true, result: packCodeActValue(result) });
              } catch (error) {
                send({ type: 'response', id, ok: false, error: String(error instanceof Error ? error.message : error).slice(0, 2000) });
              } finally { outstanding--; }
            }).catch(error => finish(error instanceof Error ? error : new Error(String(error))));
          } else if (message['type'] === 'done') {
            if (!ready || outstanding !== 0) throw new Error('codeact_finished_with_pending_calls');
            const wire = message['result'] as WireValue | undefined;
            if (!wire || !['json', 'undefined'].includes(wire.kind)) throw new Error('invalid_codeact_result');
            if (wire.display !== undefined && typeof wire.display !== 'string') throw new Error('invalid_codeact_display');
            const logs = Array.isArray(message['logs'])
              ? message['logs'].slice(0, 32).filter((item): item is string => typeof item === 'string').map(item => item.slice(0, 2000)) : [];
            finish(undefined, { value: unpackCodeActValue(wire), logs });
          } else if (message['type'] === 'error') {
            finish(new Error(`codeact_guest_error: ${String(message['error']).slice(0, 2000)}`));
          } else throw new Error('invalid_codeact_message');
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }
    });
  });
}

export function configuredCodeActProfile(): CodeActProfile {
  const config = env();
  if (!config.CODEACT_ISOLATION_ENABLED) throw new Error('codeact_isolation_disabled');
  return {
    bwrapPath: config.CODEACT_ISOLATION_BWRAP_PATH,
    prlimitPath: '/usr/bin/prlimit', nodePath: process.execPath,
    runtimeFiles: config.CODEACT_ISOLATION_RUNTIME_FILES.split(',').map(file => file.trim()).filter(Boolean),
  };
}

export async function executeIsolatedCode(code: string, capabilities: CodeActCapabilities, options: CodeActRunOptions): Promise<CodeActRunResult> {
  return runCodeActSandbox(configuredCodeActProfile(), code, capabilities, options);
}

/** Executes a tiny guest under the exact same policy; no host capabilities. */
export async function preflightCodeActIsolation(profile: CodeActProfile): Promise<{ available: boolean; reason?: string }> {
  try {
    const result = await runCodeActSandbox(profile, 'return "isolated";', new Map(), { timeoutMs: 5000 });
    return result.value === 'isolated' ? { available: true } : { available: false, reason: 'unexpected_probe_result' };
  } catch (error) { return { available: false, reason: error instanceof Error ? error.message : String(error) }; }
}
