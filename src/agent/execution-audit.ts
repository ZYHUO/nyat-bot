import { validateAcceptance, type AcceptanceContract, type AcceptanceCheck, type AcceptanceResult } from './task-evidence.js';
import { randomUUID } from 'node:crypto';
import { emitTaskRuntimeEvent } from './task-runtime-events.js';

export interface AuditSnapshot {
  totalCalls: number;
  failedCalls: number;
  retryCount: number;
  receipts: { sequence: number; name: string; ok: boolean }[];
  lastFailedName?: string;
  proposal?: AcceptanceContract;
}

export interface ExecutionAuditEventContext {
  taskId?: string;
  chatId?: number;
  cognitiveAnchorEventId?: string;
  turn?: () => number | undefined;
  segment?: () => number | undefined;
}
function returnedFailure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v['ok'] === false || v['success'] === false || !!v['error'] ||
    (typeof v['exitCode'] === 'number' && v['exitCode'] !== 0);
}

/** Host-only controller. No receipt-writing capability is exposed in the model runtime. */
export function createExecutionAudit(
  root: string,
  caller?: AcceptanceContract,
  prior?: AuditSnapshot,
  eventContext?: ExecutionAuditEventContext,
) {
  const contract = caller ? structuredClone(caller) : undefined;
  const state: AuditSnapshot = prior ? structuredClone(prior) : { totalCalls: 0, failedCalls: 0, retryCount: 0, receipts: [] };
  let verifiedAt = -1;
  let lastResult: AcceptanceResult = { status: 'unverified', reasons: ['not_checked'], checks: [] };
  let inflight = 0;
  const active = () => contract ?? state.proposal;
  const snapshot = (): AuditSnapshot => structuredClone(state);
  const record = (name: string, ok: boolean) => {
    state.totalCalls++;
    if (state.lastFailedName === name) state.retryCount++;
    state.lastFailedName = ok ? undefined : name;
    if (!ok) state.failedCalls++;
    state.receipts.push({ sequence: state.totalCalls, name, ok });
    if (state.receipts.length > 100) state.receipts.shift();
  };
  return {
    snapshot,
    hasContract: () => !!active()?.checks.length,
    propose(checks: AcceptanceCheck[]) {
      if (contract) throw new Error('caller_contract_is_immutable');
      if (!Array.isArray(checks) || checks.length === 0 || checks.length > 8) throw new Error('invalid_acceptance_checks');
      state.proposal = structuredClone({ source: 'model', checks });
      verifiedAt = -1;
    },
    async verify(): Promise<AcceptanceResult> {
      if (inflight) return { status: 'unverified', reasons: ['operations_pending'], checks: [] };
      lastResult = await validateAcceptance(root, active());
      verifiedAt = state.totalCalls;
      return structuredClone(lastResult);
    },
    assertCanEnd() {
      if (!active()?.checks.length) return;
      if (inflight || verifiedAt !== state.totalCalls || !lastResult.checks.length || lastResult.checks.some((c) => !c.ok)) {
        throw new Error('acceptance_pending_or_failed: run runtime.verifyAcceptance(), repair failed checks, then endTask');
      }
    },
    wrap<T extends object>(namespace: string, api: T): T {
      return new Proxy(api, {
        get(target, key, receiver) {
          const value: unknown = Reflect.get(target, key, receiver);
          if (typeof value !== 'function' || typeof key !== 'string' || key === 'then') return value;
          return async (...args: unknown[]) => {
            inflight++;
            const name = `${namespace}.${key}`;
            const taskId = eventContext?.taskId;
            const chatId = eventContext?.chatId;
            const invocationId = taskId && chatId !== undefined ? randomUUID() : undefined;
            if (invocationId) {
              emitTaskRuntimeEvent({
                kind: 'tool_started',
                taskId: taskId!,
                chatId: chatId!,
                cognitiveAnchorEventId: eventContext?.cognitiveAnchorEventId,
                invocationId,
                turn: eventContext?.turn?.(),
                segment: eventContext?.segment?.(),
                toolName: name,
              });
            }
            try {
              const result: unknown = await Reflect.apply(value, target, args);
              const ok = !returnedFailure(result);
              record(name, ok);
              if (invocationId) {
                emitTaskRuntimeEvent({
                  kind: 'tool_finished',
                  taskId: taskId!,
                  chatId: chatId!,
                  cognitiveAnchorEventId: eventContext?.cognitiveAnchorEventId,
                  invocationId,
                  turn: eventContext?.turn?.(),
                  segment: eventContext?.segment?.(),
                  toolName: name,
                  ...(ok ? {} : { errorCode: failureCode(result) }),
                });
              }
              return result;
            } catch (err) {
              record(name, false);
              if (invocationId) {
                emitTaskRuntimeEvent({
                  kind: 'tool_finished',
                  taskId: taskId!,
                  chatId: chatId!,
                  cognitiveAnchorEventId: eventContext?.cognitiveAnchorEventId,
                  invocationId,
                  turn: eventContext?.turn?.(),
                  segment: eventContext?.segment?.(),
                  toolName: name,
                  errorCode: failureCode(err),
                });
              }
              throw err;
            }
            finally { inflight--; }
          };
        },
      });
    },
  };
}

function failureCode(value: unknown): string {
  if (value instanceof Error && value.name && value.name !== 'Error') return value.name.slice(0, 80);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['code', 'errorCode']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(candidate.trim())) return candidate.trim();
    }
    if (typeof record['exitCode'] === 'number') return `exit_code_${record['exitCode']}`;
    if (record['ok'] === false || record['success'] === false || record['error']) return 'host_result_failed';
  }
  return 'tool_failed';
}
export type ExecutionAudit = ReturnType<typeof createExecutionAudit>;
const audits = new WeakMap<object, ExecutionAudit>();
export function attachExecutionAudit(host: object, audit: ExecutionAudit): void { audits.set(host, audit); }
export function getExecutionAudit(host: object): ExecutionAudit | undefined { return audits.get(host); }
