// Shared by the durable producer and the optional in-process fallback. Keeping
// this small avoids importing the executor (and its tools) just to shut down.
let draining = false;
let closed = false;
let failedDuringDrain = false;
const admissions = new Set<Promise<unknown>>();
let local: { stop(): void; drain(): Promise<void> } | undefined;

/** A policy refusal with a confirmed durable hold is not lost accepted work. */
export class CodeActAdmissionHeldError extends Error {}

export function isCodeActDraining(): boolean { return draining; }

export function registerLocalCodeActLifecycle(lifecycle: NonNullable<typeof local>): void {
  local = lifecycle;
  if (draining) local.stop();
}

/** Continuations from a running task may persist to BullMQ while it drains. */
export function trackCodeActAdmission<T>(work: () => Promise<T>, continuation = false): Promise<T> {
  if (closed || (draining && !continuation)) return Promise.reject(new Error('codeact_draining'));
  const pending = Promise.resolve().then(work);
  admissions.add(pending);
  void pending.then(() => admissions.delete(pending), error => {
    // Keep the failure after the producer leaves the set. The producer may
    // settle while close() is still joining a worker or a local execution.
    if (draining && !(error instanceof CodeActAdmissionHeldError)) failedDuringDrain = true;
    admissions.delete(pending);
  });
  return pending;
}

export function beginCodeActDrain(): void {
  draining = true;
  local?.stop();
}

export async function drainLocalCodeActWork(): Promise<void> { await local?.drain(); }

/** Call after workers/local tasks have joined; none can create new continuations. */
export async function finishCodeActAdmissions(): Promise<void> {
  while (admissions.size) await Promise.allSettled([...admissions]);
  closed = true;
  if (failedDuringDrain) throw new Error('codeact_admission_failed_during_drain');
}

/** Only tests can restart this process-scoped lifecycle. */
export function _resetCodeActLifecycleForTest(): void {
  draining = false;
  closed = false;
  failedDuringDrain = false;
  admissions.clear();
}
