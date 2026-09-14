// ────────────────────────────────────────
// Agency Action Space (CSR Phase E skeleton)
//
// 统一动作空间：legacy reply / Heart / Meta / CodeAct 未来逐步收敛到
// 这套动作类型。运行时职责是校验（scope/权限/预算），不替模型决定
// 该选哪个动作。本文件先提供类型与校验器；执行后端接入是后续阶段。
// ────────────────────────────────────────

export type AgencyAction =
  | { type: 'speak'; text: string; replyToMessageId?: number }
  | { type: 'act'; goal: string; taskId?: string }
  | { type: 'ask'; question: string; replyToMessageId?: number }
  | { type: 'wait'; reason: string; waitSec?: number }
  | { type: 'observe'; target: string; args?: Record<string, unknown> }
  | { type: 'remember'; fact: string }
  | { type: 'correct'; debtId: number; resolution: string }
  | { type: 'stop'; reason: string };

export interface AgencyValidationResult {
  ok: boolean;
  reason?: string;
  action?: AgencyAction;
}

const TEXTUAL_MAX = 4000;
const OBSERVE_ARGS_MAX_BYTES = 4000;

/**
 * 校验一条 AgencyAction 的结构与基本边界。
 * 只做确定性检查（类型/长度/数字范围），不做语义判断。
 */
export function validateAgencyAction(raw: unknown): AgencyValidationResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'not_object' };
  const a = raw as Record<string, unknown>;
  const type = a['type'];
  switch (type) {
    case 'speak':
    case 'ask': {
      const text = typeof a['text'] === 'string' ? a['text'].trim() : typeof a['question'] === 'string' ? (a['question'] as string).trim() : '';
      if (!text) return { ok: false, reason: `${type}:empty_text` };
      if (text.length > TEXTUAL_MAX) return { ok: false, reason: `${type}:text_too_long` };
      const replyTo = a['replyToMessageId'];
      if (replyTo !== undefined && (typeof replyTo !== 'number' || !Number.isInteger(replyTo) || replyTo <= 0)) {
        return { ok: false, reason: `${type}:bad_reply_to` };
      }
      return { ok: true, action: type === 'speak'
        ? { type: 'speak', text, ...(replyTo !== undefined ? { replyToMessageId: replyTo as number } : {}) }
        : { type: 'ask', question: text, ...(replyTo !== undefined ? { replyToMessageId: replyTo as number } : {}) } };
    }
    case 'act': {
      const goal = typeof a['goal'] === 'string' ? a['goal'].trim() : '';
      if (!goal) return { ok: false, reason: 'act:empty_goal' };
      return { ok: true, action: { type: 'act', goal: goal.slice(0, 2000), ...(typeof a['taskId'] === 'string' ? { taskId: a['taskId'] as string } : {}) } };
    }
    case 'wait': {
      const reason = typeof a['reason'] === 'string' ? a['reason'].trim() : '';
      if (!reason) return { ok: false, reason: 'wait:empty_reason' };
      const waitSec = a['waitSec'];
      if (waitSec !== undefined && (typeof waitSec !== 'number' || !Number.isFinite(waitSec) || waitSec < 0 || waitSec > 24 * 3600)) {
        return { ok: false, reason: 'wait:bad_wait_sec' };
      }
      return { ok: true, action: { type: 'wait', reason: reason.slice(0, 500), ...(waitSec !== undefined ? { waitSec } : {}) } };
    }
    case 'observe': {
      const target = typeof a['target'] === 'string' ? a['target'].trim() : '';
      if (!target) return { ok: false, reason: 'observe:empty_target' };
      let args: Record<string, unknown> | undefined;
      if (a['args'] !== undefined) {
        if (typeof a['args'] !== 'object' || a['args'] === null || Array.isArray(a['args'])) {
          return { ok: false, reason: 'observe:bad_args' };
        }
        try {
          const serialized = JSON.stringify(a['args']);
          if (typeof serialized !== 'string' || serialized.length > OBSERVE_ARGS_MAX_BYTES) {
            return { ok: false, reason: 'observe:args_too_large' };
          }
        } catch {
          return { ok: false, reason: 'observe:args_not_serializable' };
        }
        args = a['args'] as Record<string, unknown>;
      }
      return {
        ok: true,
        action: { type: 'observe', target: target.slice(0, 500), ...(args ? { args } : {}) },
      };
    }
    case 'remember': {
      const fact = typeof a['fact'] === 'string' ? a['fact'].trim() : '';
      if (!fact) return { ok: false, reason: 'remember:empty_fact' };
      return { ok: true, action: { type: 'remember', fact: fact.slice(0, 1000) } };
    }
    case 'correct': {
      const debtId = a['debtId'];
      const resolution = typeof a['resolution'] === 'string' ? a['resolution'].trim() : '';
      if (typeof debtId !== 'number' || !Number.isInteger(debtId) || debtId <= 0) return { ok: false, reason: 'correct:bad_debt_id' };
      if (!resolution) return { ok: false, reason: 'correct:empty_resolution' };
      return { ok: true, action: { type: 'correct', debtId, resolution: resolution.slice(0, 400) } };
    }
    case 'stop': {
      const reason = typeof a['reason'] === 'string' ? a['reason'].trim() : '';
      if (!reason) return { ok: false, reason: 'stop:empty_reason' };
      return { ok: true, action: { type: 'stop', reason: reason.slice(0, 500) } };
    }
    default:
      return { ok: false, reason: 'unknown_type' };
  }
}
