import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { assertPendingIntentCurrent } from '../meta/pending-intent.js';
import type { DispatchTask } from '../meta/types.js';
import type { DeliveryResult } from '../shared/delivery-result.js';
import {
  readPublicationEvidence,
  validatePublicationEvidence,
} from './background-evidence.js';

export interface BackgroundOrigin {
  kind: 'goal' | 'self_play' | 'dreaming';
  key: string;
  sinceAt: number;
}
interface CheckRow {
  task_id: string;
  chat_id: number;
  platform: string;
  account_id: string;
  thread_id: number;
  origin_kind: string;
  origin_key: string;
  origin_hash: string;
  since_at: number;
  created_at: number;
  version: number;
  state: string;
  owner: string | null;
  reason: string | null;
}
interface ProposalRow {
  id: string;
  task_id: string;
  version: number;
  text: string;
  text_hash: string;
  handles_json: string;
  evidence_hash: string;
  state: string;
  created_at: number;
  attempted_at: number | null;
}
export interface BackgroundRun {
  task: DispatchTask;
  owner: string;
  version: number;
}
export interface PublicationOutcome {
  state: 'sent' | 'suppressed' | 'failed' | 'unknown';
  reason: string;
  proposalId?: string;
  delivery?: DeliveryResult;
}
const hash = (input: unknown) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
const check = (id: string) =>
  getDb().prepare('SELECT * FROM background_checks WHERE task_id=?').get(id) as
    CheckRow | undefined;
const proposal = (id: string) =>
  getDb()
    .prepare('SELECT * FROM background_publications WHERE task_id=?')
    .get(id) as ProposalRow | undefined;
function durable<T>(fn: () => T): T {
  const db = getDb();
  if (db.inTransaction) return db.transaction(fn)();
  const old = Number(db.pragma('synchronous', { simple: true }));
  db.pragma('synchronous=FULL');
  try {
    return db.transaction(fn)();
  } finally {
    db.pragma(`synchronous=${old}`);
  }
}
export function isBackgroundTask(
  task: Pick<DispatchTask, 'executionMode'>,
): boolean {
  return task.executionMode === 'background';
}

function originHash(origin: BackgroundOrigin, chatId: number): string {
  if (
    (origin.kind === 'self_play' || origin.kind === 'dreaming') &&
    origin.key === origin.kind
  ) {
    if (env().MASTER_UID <= 0 || chatId !== env().MASTER_UID) throw new Error('background_owner_changed');
    return hash([origin.kind, chatId]);
  }
  if (origin.kind !== 'goal' || !/^[1-9]\d*$/.test(origin.key))
    throw new Error('background_origin_invalid');
  const goal = getDb()
    .prepare(
      'SELECT id,topic,origin,chat_id,status,check_count FROM goals WHERE id=?',
    )
    .get(Number(origin.key)) as
    | {
        id: number;
        topic: string;
        origin: string;
        chat_id: number | null;
        status: string;
        check_count: number;
      }
    | undefined;
  if (
    !goal ||
    goal.status !== 'active' ||
    (goal.chat_id ?? env().MASTER_UID) !== chatId
  )
    throw new Error('background_origin_inactive');
  return hash(goal);
}

/** Called only at the trusted periodic producer, before enqueue. No model text
 * or old '[goal:]' string can turn a foreground task into this mode. */
export function prepareBackgroundTask(
  task: DispatchTask,
  origin: BackgroundOrigin,
): DispatchTask {
  if (env().BACKGROUND_PUBLICATION_ENABLED !== true) return task;
  const scope = resolveConversationScope(task.chatId);
  if (
    !scope?.accountId ||
    !Number.isSafeInteger(origin.sinceAt) ||
    origin.sinceAt <= 0 ||
    origin.sinceAt > task.createdAt
  )
    throw new Error('background_scope_invalid');
  const sourceHash = originHash(origin, task.chatId);
  durable(() => {
    const existing = check(task.id);
    if (existing) throw new Error('background_task_exists');
    getDb()
      .prepare(
        `INSERT INTO background_checks(task_id,chat_id,platform,account_id,thread_id,origin_kind,origin_key,origin_hash,since_at,created_at,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending')`,
      )
      .run(
        task.id,
        task.chatId,
        scope.platform,
        scope.accountId,
        task.messageThreadId ?? 0,
        origin.kind,
        origin.key,
        sourceHash,
        origin.sinceAt,
        task.createdAt,
      );
  });
  return {
    ...task,
    executionMode: 'background',
    backgroundOrigin: structuredClone(origin),
  };
}
function assertCheck(task: DispatchTask, row: CheckRow): void {
  const scope = resolveConversationScope(task.chatId),
    origin = task.backgroundOrigin;
  if (
    env().BACKGROUND_PUBLICATION_ENABLED !== true ||
    !isBackgroundTask(task) ||
    !origin ||
    !scope?.accountId ||
    scope.platform !== row.platform ||
    scope.accountId !== row.account_id ||
    task.chatId !== row.chat_id ||
    (scope.platform === 'qq' && scope.accountId !== env().ONEBOT_ACCOUNT_ID) ||
    (task.messageThreadId ?? 0) !== row.thread_id ||
    task.createdAt !== row.created_at ||
    origin.kind !== row.origin_kind ||
    origin.key !== row.origin_key ||
    origin.sinceAt !== row.since_at ||
    originHash(origin, task.chatId) !== row.origin_hash
  )
    throw new Error('background_scope_or_origin_changed');
  assertPendingIntentCurrent(task.pendingIntent);
}
export function beginBackgroundTask(task: DispatchTask): BackgroundRun {
  return durable(() => {
    const row = check(task.id);
    if (!row || row.state !== 'pending')
      throw new Error('background_replay_held');
    assertCheck(task, row);
    const owner = randomUUID();
    getDb()
      .prepare(
        "UPDATE background_checks SET state='running',owner=? WHERE task_id=? AND state='pending'",
      )
      .run(owner, task.id);
    // A crashed running check is held, not retried with a potentially sent draft.
    return { task: structuredClone(task), owner, version: row.version };
  });
}
function assertRun(run: BackgroundRun): CheckRow {
  const row = check(run.task.id);
  if (
    !row ||
    row.state !== 'running' ||
    row.owner !== run.owner ||
    row.version !== run.version
  )
    throw new Error('background_generation_closed');
  assertCheck(run.task, row);
  return row;
}
/** The executor also checks the fixed claim between model/tool awaits so a
 * cancelled check stops spending its compute budget, not only its send budget. */
export function assertBackgroundTaskCurrent(run: BackgroundRun): void {
  assertRun(run);
}
export function cancelBackgroundTask(taskId: string): void {
  durable(() => {
    getDb()
      .prepare(
        "UPDATE background_checks SET state='cancelled',version=version+1,reason='cancelled' WHERE task_id=? AND state IN ('pending','running')",
      )
      .run(taskId);
    getDb()
      .prepare(
        "UPDATE background_publications SET state='suppressed',reason='cancelled' WHERE task_id=? AND state='proposed'",
      )
      .run(taskId);
  });
}
export function readBackgroundEvidence(
  run: BackgroundRun,
  request: { kind: 'message'; messageId: number },
) {
  assertRun(run);
  const proof = readPublicationEvidence(
    run.task.chatId,
    run.task.messageThreadId ?? 0,
    request,
  );
  const count = (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM background_evidence WHERE task_id=?')
      .get(run.task.id) as { n: number }
  ).n;
  if (count >= 12) throw new Error('background_evidence_budget');
  const handle = randomUUID();
  getDb()
    .prepare('INSERT INTO background_evidence VALUES (?,?,?)')
    .run(handle, run.task.id, JSON.stringify(proof));
  return {
    handle,
    text: proof.text,
    version: proof.version,
    changedAt: proof.changedAt,
  };
}
function proofsFor(run: BackgroundRun, handles: string[]) {
  return handles.map((handle) => {
    const saved = getDb()
      .prepare(
        'SELECT proof_json FROM background_evidence WHERE handle=? AND task_id=?',
      )
      .get(handle, run.task.id) as { proof_json: string } | undefined;
    if (!saved) throw new Error('source_unregistered');
    const proof = JSON.parse(saved.proof_json) as ReturnType<
      typeof readPublicationEvidence
    >;
    if (!validatePublicationEvidence(proof)) throw new Error('source_changed');
    return proof;
  });
}
export function proposeBackgroundPublication(
  run: BackgroundRun,
  text: string,
  handles: string[],
) {
  return durable(() => {
    assertRun(run);
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 200 ||
      !Array.isArray(handles) ||
      handles.length < 1 ||
      handles.length > 3 ||
      handles.some((h) => typeof h !== 'string')
    )
      throw new Error('publication_proposal_invalid');
    if (proposal(run.task.id)) throw new Error('publication_proposal_budget');
    const proofs = proofsFor(run, [...new Set(handles)]);
    const evidenceHash = hash(
      proofs.map((p) => [p.kind, p.sourceId, p.version, p.hash]).sort(),
    );
    const id = randomUUID();
    getDb()
      .prepare(
        `INSERT INTO background_publications(id,task_id,version,text,text_hash,handles_json,evidence_hash,state,created_at)
      VALUES (?,?,?,?,?,?,?,'proposed',?)`,
      )
      .run(
        id,
        run.task.id,
        run.version,
        text.trim(),
        hash(text.trim()),
        JSON.stringify(handles),
        evidenceHash,
        Date.now(),
      );
    return { proposalId: id, state: 'proposed' as const }; // Deliberately no ACK/messageId.
  });
}
function suppress(run: BackgroundRun, reason: string): PublicationOutcome {
  durable(() => {
    getDb()
      .prepare(
        `UPDATE background_publications SET state='suppressed',reason=? WHERE task_id=? AND state='proposed' AND version=?
      AND EXISTS(SELECT 1 FROM background_checks c WHERE c.task_id=background_publications.task_id AND c.owner=? AND c.version=? AND c.state='running')`,
      )
      .run(reason, run.task.id, run.version, run.owner, run.version);
    getDb()
      .prepare(
        "UPDATE background_checks SET state='closed',reason=? WHERE task_id=? AND state='running' AND owner=? AND version=?",
      )
      .run(reason, run.task.id, run.owner, run.version);
  });
  return { state: 'suppressed', reason, proposalId: proposal(run.task.id)?.id };
}

/** Only the host terminal path invokes publication. Draft creation is never a
 * delivery receipt. A sending/unknown row is never automatically reclaimed. */
export async function finishBackgroundTask(
  run: BackgroundRun,
  terminal: { status: string; summary: string },
  assertOpen: () => void = () => {},
): Promise<PublicationOutcome> {
  const draft = proposal(run.task.id);
  if (draft && draft.state !== 'proposed')
    return {
      state:
        draft.state === 'sent'
          ? 'sent'
          : draft.state === 'failed'
            ? 'failed'
            : draft.state === 'suppressed'
              ? 'suppressed'
              : 'unknown',
      reason: 'already_final_or_in_flight',
      proposalId: draft.id,
    };
  if (terminal.status !== 'done' || terminal.summary !== 'finding')
    return suppress(
      run,
      terminal.summary === 'no_update' || terminal.summary === 'no_change'
        ? 'no_change'
        : 'terminal_not_finding',
    );
  if (!draft) return suppress(run, 'source_unregistered');
  try {
    assertRun(run);
    assertOpen();
  } catch {
    return suppress(run, 'cancelled_or_scope_changed');
  }
  let proofs: ReturnType<typeof proofsFor>;
  try {
    proofs = proofsFor(run, JSON.parse(draft.handles_json) as string[]);
  } catch {
    return suppress(run, 'source_changed');
  }
  const row = check(run.task.id)!;
  if (!proofs.some((p) => p.changedAt >= row.since_at))
    return suppress(run, 'no_new_source_version');
  const duplicate = () =>
    getDb()
      .prepare(
        `SELECT 1 FROM background_publications p JOIN background_checks c ON c.task_id=p.task_id
    WHERE c.platform=? AND c.account_id=? AND c.chat_id=? AND c.thread_id=? AND c.origin_kind=? AND c.origin_key=?
      AND p.id!=? AND p.state IN ('sending','sent','unknown') AND (p.evidence_hash=? OR p.text_hash=?) LIMIT 1`,
      )
      .get(
        row.platform,
        row.account_id,
        row.chat_id,
        row.thread_id,
        row.origin_kind,
        row.origin_key,
        draft.id,
        draft.evidence_hash,
        draft.text_hash,
      );
  if (duplicate()) return suppress(run, 'already_published_or_uncertain');
  const { checkProactiveActivation } =
    await import('../cron/activation-policy.js');
  if (!(await checkProactiveActivation(run.task.chatId)).allowed)
    return suppress(run, 'activation_denied');
  const { tryAcquireProactiveSlot, markProactiveSent } =
    await import('../cron/proactive-coordinator.js');
  if (
    !(await tryAcquireProactiveSlot(run.task.chatId, 'background-publication'))
  )
    return suppress(run, 'notification_budget');
  // Separate durable notification budget. Checking/reading does not debit it.
  const claimed = durable(() => {
    assertRun(run);
    assertOpen();
    proofsFor(run, JSON.parse(draft.handles_json) as string[]);
    if (duplicate()) return false;
    const count = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM background_publications p JOIN background_checks c ON c.task_id=p.task_id
      WHERE c.platform=? AND c.account_id=? AND c.chat_id=? AND p.attempted_at>? AND p.state IN ('sending','sent','unknown')`,
        )
        .get(
          row.platform,
          row.account_id,
          row.chat_id,
          Date.now() - 3600000,
        ) as { n: number }
    ).n;
    const max = Math.max(
      1,
      Math.min(10, env().PROACTIVE_HOURLY_MAX_PER_CHAT || 1),
    );
    if (count >= max) return false;
    return (
      getDb()
        .prepare(
          "UPDATE background_publications SET state='sending',attempted_at=? WHERE id=? AND state='proposed'",
        )
        .run(Date.now(), draft.id).changes === 1
    );
  });
  if (!claimed) return suppress(run, 'notification_budget_or_claimed');
  let delivery: DeliveryResult;
  try {
    const { sendMessageDetailed } = await import('../bot/sender/telegram.js');
    delivery = await sendMessageDetailed(
      run.task.chatId,
      draft.text,
      undefined,
      run.task.messageThreadId,
      {
        intentId: `background:${draft.id}`,
        revision: run.version,
        beforeSend: () => {
          assertOpen();
          assertRun(run);
          proofsFor(run, JSON.parse(draft.handles_json) as string[]);
        },
      },
    );
  } catch {
    delivery = {
      status: 'unknown',
      chatId: run.task.chatId,
      intentId: `background:${draft.id}`,
      revision: run.version,
      parts: [],
      plannedPartCount: 1,
      reason: 'publication_transport_unclassified',
    };
  }
  if (
    (delivery.status !== 'sent' && delivery.parts.length > 0) ||
    (delivery.status === 'sent' && delivery.parts.length === 0)
  ) {
    // A definite rejection of the tail does not undo the confirmed prefix.
    // Hold the whole publication so another check cannot resend that prefix.
    delivery = {
      ...delivery,
      status: 'unknown',
      reason: 'partial_or_invalid_publication_receipt',
    };
  }
  // Store all observed ACKs even if cancellation happened during the request.
  // Never serialize transport errors/credentials into the durable receipt.
  const receipt = {
    status: delivery.status,
    parts: delivery.parts,
    plannedPartCount: delivery.plannedPartCount,
  };
  durable(() => {
    getDb()
      .prepare(
        "UPDATE background_publications SET state=?,receipt_json=?,reason=? WHERE id=? AND state='sending'",
      )
      .run(
        delivery.status,
        JSON.stringify(receipt),
        delivery.reason ?? delivery.status,
        draft.id,
      );
    getDb()
      .prepare(
        "UPDATE background_checks SET state='closed',reason=? WHERE task_id=? AND state='running' AND owner=? AND version=?",
      )
      .run(delivery.status, run.task.id, run.owner, run.version);
  });
  if (delivery.parts.length) {
    try {
      const [{ addAssistant }, { memorizeAcknowledgedDelivery }] =
        await Promise.all([
          import('../pipeline/context/manager.js'),
          import('../memory/chroma.js'),
        ]);
      for (const part of delivery.parts) {
        await addAssistant(
          run.task.chatId,
          { textContent: part.text, messageId: part.messageId },
          run.task.messageThreadId,
        );
        await memorizeAcknowledgedDelivery(run.task.chatId, part);
      }
    } catch {
      // The durable receipt remains authoritative; never retry a physical send
      // because a secondary context/vector projection is temporarily down.
      delivery = { ...delivery, reason: 'ack_bookkeeping_pending' };
      getDb()
        .prepare('UPDATE background_publications SET reason=? WHERE id=?')
        .run(delivery.reason, draft.id);
    }
  }
  if (delivery.status === 'sent')
    await markProactiveSent(run.task.chatId, 'background-publication');
  return {
    state: delivery.status,
    reason: delivery.reason ?? delivery.status,
    proposalId: draft.id,
    delivery,
  };
}
