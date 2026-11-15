import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodeActCapabilities } from '../../../src/sandbox/codeact/capabilities.js';
import type { AICallOptions } from '../../../src/ai/types.js';
import type { FormattedMessage } from '../../../src/shared/types.js';

let db: Database.Database;
let directory: string;
let databasePath: string;
let modelRequests = 0;
let executions = 0;
let executeMode: 'success' | 'failure' = 'success';
let beforeRequest: (() => void) | undefined;
let lastMessages: AICallOptions['messages'] = [];
const base = 1_700_000_000;
const DAY = 86400;
const config: Record<string, unknown> = { BOT_TOKEN: '123:test', MASTER_UID: 42,
  LIFE_PROJECT_ENABLED: true, LIFE_PROJECT_ARTIFACT_DIR: '', EMOTION_CONTINUITY_ENABLED: true,
  COGNITIVE_EVENTS_ENABLED: true, CODEACT_ISOLATION_ENABLED: true, CODEACT_USAGE: 'reply', OWNER_MEMORY_LINK_ENABLED: false };
vi.mock('../../../src/db/sqlite.js', () => ({ getDb: () => db }));
vi.mock('../../../src/env.js', () => ({ env: () => config }));
vi.mock('../../../src/shared/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: (): unknown => logger };
  return { logger };
});
vi.mock('../../../src/ai/fallback.js', () => ({ callWithFallback: async (options: AICallOptions) => {
  beforeRequest?.();
  await options.beforeProviderRequest?.(); // Real persistent domain CAS, not a mock counter.
  modelRequests++;
  lastMessages = options.messages;
  expect(options.maxTokens).toBe(1200); expect(options.signal).toBeInstanceOf(AbortSignal);
  return { content: '```js\n// known synthetic CodeAct program\n```' };
} }));
vi.mock('../../../src/sandbox/codeact/runner.js', () => ({ executeIsolatedCode: async (_code: string, capabilities: CodeActCapabilities) => {
  executions++;
  // The real OS guest has a separate integration proof. Here only that boundary
  // is replaced; real domain writes, capability closure, acceptance and ledger run.
  expect([...capabilities.keys()].sort()).toEqual(['creation.writePoem', 'runtime.endTask', 'runtime.verifyAcceptance']);
  expect(capabilities.has('telegram.sendText')).toBe(false);
  expect(capabilities.has('web.search')).toBe(false);
  expect(capabilities.has('computer.writeFile')).toBe(false);
  if (executeMode === 'failure') await capabilities.get('creation.writePoem')!('不是四行的失败草稿');
  const ordinal = (db.prepare("SELECT ordinal FROM life_project_attempts WHERE status='running' LIMIT 1").get() as { ordinal: number }).ordinal;
  await capabilities.get('creation.writePoem')!(`第${ordinal}版窗前月\n轻风掠过桥\n灯边留旧句\n明日再推敲`);
  expect(await capabilities.get('runtime.verifyAcceptance')!()).toMatchObject({ status: 'verified' });
  await capabilities.get('runtime.endTask')!();
  return { value: { saved: true }, logs: [] };
} }));
vi.mock('../../../src/pipeline/context/manager.js', () => ({ getRecent: async (): Promise<FormattedMessage[]> => [] }));
vi.mock('../../../src/bot/bot.js', () => ({ getBotIdentity: () => ({ uid: 123 }) }));
vi.mock('../../../src/tracking/scratchpad.js', () => ({ getScratch: async () => [] }));
vi.mock('../../../src/tracking/social-needs.js', () => ({ getSocialNeed: async () => 0.5 }));
vi.mock('../../../src/subagent/task-store.js', () => ({ loadCodeActTask: async () => null }));
vi.mock('../../../src/context-engine/index.js', () => ({ getContextEngine: () => ({
  assemble: async (providers: Array<{ provide: () => { text: string } }>) => ({ prompt: providers.map((p) => p.provide().text).join('\n') }),
}) }));

import { activateLifeProject, cancelLifeProject, claimLifeAttempt, consumeLifeModelRequest, findLifeProject,
  lifeProjectContext, settleLifeAttempt, verifyLifeArtifact, writeLifeArtifact, type LifeAttempt } from '../../../src/agent/life-project.js';
import { listDueProcessWakes, listPendingProcessWakes, listProcessCheckpointsForTest,
  runCognitiveContinuityTick, getMissionContinuity, requestProcessWake } from '../../../src/agent/cognitive-continuity.js';
import { runCognitiveProcessTick } from '../../../src/agent/cognitive-process-runtime.js';
import { runLifeProjectWake } from '../../../src/agent/life-project-runner.js';
import { buildCognitiveWorkspace } from '../../../src/agent/cognitive-workspace.js';
import { appendCognitiveEvent } from '../../../src/agent/cognitive-events.js';

function reopen(): void {
  if (db?.open) db.close();
  db = new Database(databasePath);
  db.pragma('journal_mode=WAL'); db.pragma('foreign_keys=ON'); db.pragma('synchronous=FULL');
}
function activate(maxAttempts = 8) {
  return activateLifeProject({ chatId: 42, objective: '练习四行中文短诗；保留真实数字作品与失败', operatorRef: 'unit-test-operator', maxAttempts });
}
const poem = '窗前留一月\n轻风绕旧桥\n灯边翻短句\n明日再推敲';

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(base * 1000);
  directory = mkdtempSync(join(tmpdir(), 'nyat-life-project-'));
  databasePath = join(directory, 'state.sqlite');
  config['BOT_TOKEN'] = '123:test'; config['LIFE_PROJECT_ENABLED'] = true;
  config['EMOTION_CONTINUITY_ENABLED'] = true;
  config['CODEACT_ISOLATION_ENABLED'] = true;
  config['LIFE_PROJECT_ARTIFACT_DIR'] = join(directory, 'artifacts');
  beforeRequest = undefined; executeMode = 'success'; modelRequests = 0; executions = 0; lastMessages = [];
  reopen();
  for (const name of ['0089_cognitive_events.sql', '0118_platform_identity.sql', '0128_emotion_projection.sql', '0130_life_project.sql']) {
    db.exec(readFileSync(`migrations/${name}`, 'utf8'));
  }
});
afterEach(() => { db.close(); vi.useRealTimers(); rmSync(directory, { recursive: true, force: true }); });

describe('bounded owner digital project', () => {
  it('activation is a host operator fact, never a forged user message, and scope/flag gates are mandatory', () => {
    expect(() => activateLifeProject({ chatId: -42, objective: '群项目', operatorRef: 'operator' })).toThrow('owner_scope');
    expect(() => activateLifeProject({ chatId: 77, objective: '别人的项目', operatorRef: 'operator' })).toThrow('owner_scope');
    config['LIFE_PROJECT_ENABLED'] = false; expect(() => activate()).toThrow('disabled');
    config['LIFE_PROJECT_ENABLED'] = true;
    const first = activate(); expect(activate().id).toBe(first.id);
    const rows = db.prepare('SELECT type,source,fact_json FROM cognitive_events').all() as Array<{ type: string; source: string; fact_json: string }>;
    expect(rows.some(row => row.type === 'message_received' || row.source === 'telegram')).toBe(false);
    expect(rows.find(row => row.type === 'task_observation')!.fact_json).toContain('operator_activated_digital_project');
    expect(findLifeProject(first.id)!.attempts_started).toBe(0);
  });

  it('reopens real SQLite every day for 30 days: preserves versions/failure and stops at eight actual attempts', async () => {
    const project = activate();
    let firstHash = '';
    for (let day = 0; day < 30; day++) {
      vi.setSystemTime((base + day * DAY) * 1000); reopen();
      executeMode = day === 2 ? 'failure' : 'success';
      runCognitiveContinuityTick(base + day * DAY);
      await runCognitiveProcessTick(base + day * DAY);
      // Every hourly duplicate read/tick must be free of new practice and calls.
      const calls = modelRequests;
      await runCognitiveProcessTick(base + day * DAY + 3600);
      expect(modelRequests).toBe(calls);
      if (day === 0) firstHash = (db.prepare('SELECT artifact_sha256 FROM life_project_attempts WHERE ordinal=1').get() as { artifact_sha256: string }).artifact_sha256;
      if (day === 3) expect(JSON.stringify(lastMessages)).toContain('failed');
      if (day === 12) {
        appendCognitiveEvent({ type: 'task_observation', source: 'host', scope: { visibility: 'chat', chatId: 42 },
          fact: { kind: 'synthetic_friend_departure_observation', evidence: 'offline-fixture-only' }, dedupeKey: 'fixture:friend-departure' });
      }
    }
    const attempts = db.prepare('SELECT * FROM life_project_attempts ORDER BY ordinal').all() as LifeAttempt[];
    expect(attempts).toHaveLength(8); expect(attempts.map(row => row.status)).toEqual(['succeeded', 'succeeded', 'failed', 'succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded']);
    expect(attempts.reduce((n, row) => n + row.llm_requests, 0)).toBe(modelRequests);
    expect(modelRequests).toBe(9); // Seven successes, one failed attempt with two bounded calls.
    expect(findLifeProject(project.id)).toMatchObject({ status: 'exhausted', attempts_started: 8 });
    expect(getMissionContinuity(project.mission_id)!.status).toBe('failed');
    expect(attempts[0]!.artifact_sha256).toBe(firstHash);
    for (const attempt of attempts.filter(row => row.artifact_name)) {
      const bytes = readFileSync(join(directory, 'artifacts', project.id, attempt.artifact_name!));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(attempt.artifact_sha256);
    }
    expect(readdirSync(join(directory, 'artifacts', project.id))).toHaveLength(7);
    expect((db.prepare("SELECT count(*) AS n FROM cognitive_events WHERE dedupe_key='fixture:friend-departure'").get() as { n: number }).n).toBe(1);
    expect(listDueProcessWakes(base + 31 * DAY)).toEqual([]);
  }, 15_000);

  it('actual Meta workspace consumes verified scoped files and never exposes a private canary in another conversation/account', async () => {
    const project = activate(1), wake = listDueProcessWakes(base)[0]!;
    const claim = claimLifeAttempt(project, wake)!;
    writeLifeArtifact(claim, '主人私密标记CANARY\n轻风绕过桥\n灯边留旧句\n明日再推敲');
    expect(await verifyLifeArtifact(claim)).toBe(true);
    settleLifeAttempt(claim, 'succeeded', 'artifact_verified');
    const workspace = await buildCognitiveWorkspace({ chatId: 42 });
    expect(workspace.parts.find(part => part.id === 'workspace:digital-project')?.text).toContain('CANARY');
    expect(lifeProjectContext(-42)).toBe(''); expect(lifeProjectContext(77)).toBe('');
    config['BOT_TOKEN'] = '456:test';
    expect(lifeProjectContext(42)).toBe('');
    expect((await buildCognitiveWorkspace({ chatId: 42 })).parts.some(part => part.id === 'workspace:digital-project')).toBe(false);
    config['BOT_TOKEN'] = '123:test';
    expect(lifeProjectContext(42, base - 1)).toBe('');
  }, 15_000);

  it('competing ticks have one parent-scope claim and never generate two versions', async () => {
    const project = activate(), wake = listDueProcessWakes(base)[0]!;
    const results = await Promise.all([runLifeProjectWake(project, wake, base), runLifeProjectWake(project, wake, base)]);
    expect(results.map(result => result.status).sort()).toEqual(['completed', 'waiting']);
    expect(modelRequests).toBe(1); expect(executions).toBe(1);
    expect(findLifeProject(project.id)!.attempts_started).toBe(1);
  });

  it('competing actual runtime ticks leave one future wake and cannot spend a second model request', async () => {
    const project = activate();
    const results = await Promise.all([runCognitiveProcessTick(base), runCognitiveProcessTick(base)]);
    expect(results.reduce((count, result) => count + result.completed, 0)).toBe(1);
    expect(modelRequests).toBe(1); expect(executions).toBe(1);
    expect(findLifeProject(project.id)!.attempts_started).toBe(1);
    expect(listPendingProcessWakes()).toHaveLength(1);
    expect(listPendingProcessWakes()[0]!.wakeAt).toBe(base + DAY);
  });

  it('turning off the feature or OS isolation leaves queued work without starting or charging a model', async () => {
    const project = activate();
    config['LIFE_PROJECT_ENABLED'] = false;
    await runCognitiveProcessTick(base);
    config['LIFE_PROJECT_ENABLED'] = true; config['CODEACT_ISOLATION_ENABLED'] = false;
    await runCognitiveProcessTick(base);
    expect(findLifeProject(project.id)!.attempts_started).toBe(0);
    expect(modelRequests).toBe(0); expect(executions).toBe(0);
  });

  it('request CAS never refunds unknown calls; crash/reopen holds the attempt and cannot run it again', async () => {
    const project = activate(), wake = listDueProcessWakes(base)[0]!;
    const claim = claimLifeAttempt(project, wake)!;
    consumeLifeModelRequest(claim); consumeLifeModelRequest(claim);
    expect(() => consumeLifeModelRequest(claim)).toThrow('budget_exhausted');
    vi.setSystemTime((base + 120) * 1000); reopen();
    await runCognitiveProcessTick(base + 120);
    const attempt = db.prepare('SELECT * FROM life_project_attempts').get() as LifeAttempt;
    expect(attempt).toMatchObject({ status: 'unknown', llm_requests: 2 });
    expect(findLifeProject(project.id)!.status).toBe('held');
    expect(listPendingProcessWakes()).toEqual([]);
    expect(listProcessCheckpointsForTest().get(wake.wakeEventId)).toMatchObject({ status: 'waiting', outcomeEventIds: [] });
    expect(db.prepare("SELECT count(*) AS n FROM cognitive_events WHERE type='cognitive_process_stopped'").get()).toEqual({ n: 1 });
    expect(runCognitiveContinuityTick(base + 2 * DAY)).toEqual({ missionsWoken: 0, processesWoken: 0 });
    await runCognitiveProcessTick(base + 2 * DAY);
    expect(modelRequests).toBe(0); expect(findLifeProject(project.id)!.attempts_started).toBe(1);
  });

  it('cancel and account change before the real request prevent generation, files, and resume after restart', async () => {
    const project = activate();
    beforeRequest = () => { cancelLifeProject(project.id, 42); };
    await runCognitiveProcessTick(base);
    expect(modelRequests).toBe(0); expect(executions).toBe(0);
    reopen(); vi.setSystemTime((base + DAY) * 1000);
    await runCognitiveProcessTick(base + DAY);
    expect(modelRequests).toBe(0); expect(findLifeProject(project.id)!.status).toBe('cancelled');
    beforeRequest = undefined;
    const next = activate(); config['BOT_TOKEN'] = '456:test';
    reopen(); await runCognitiveProcessTick(base + DAY);
    expect(modelRequests).toBe(0); expect(findLifeProject(next.id)!.attempts_started).toBe(0);
  });

  it('real file tampering cannot pass final settlement or become a recalled completed work', async () => {
    const project = activate(), wake = listDueProcessWakes(base)[0]!, claim = claimLifeAttempt(project, wake)!;
    const receipt = writeLifeArtifact(claim, poem);
    expect(writeLifeArtifact(claim, poem)).toEqual(receipt);
    expect(await verifyLifeArtifact(claim)).toBe(true);
    const path = join(directory, 'artifacts', project.id, `${claim.attempt.id}.txt`);
    writeFileSync(path, '这不是原作品');
    await expect(verifyLifeArtifact(claim)).resolves.toBe(false);
    expect(() => settleLifeAttempt(claim, 'succeeded', 'artifact_verified')).toThrow('verification_failed');
    expect(() => writeLifeArtifact(claim, poem)).toThrow('verification_failed');
    expect(lifeProjectContext(42)).not.toContain('这不是原作品');
    expect((db.prepare('SELECT status FROM life_project_attempts').get() as { status: string }).status).toBe('running');
  });

  it('unrelated same-owner wake cannot be substituted, and a project left untouched expires without LLM use', async () => {
    const project = activate(), wake = listDueProcessWakes(base)[0]!;
    requestProcessWake({ processId: 'unrelated', scope: { visibility: 'chat', chatId: 42 }, kind: 'strategist', reason: 'test', wakeAt: base });
    const unrelated = listDueProcessWakes(base).find(item => item.processId === 'unrelated')!;
    expect(claimLifeAttempt(project, unrelated)).toBeNull();
    expect(claimLifeAttempt(project, { ...wake, wakeEventId: unrelated.wakeEventId })).toBeNull();
    vi.setSystemTime((base + 31 * DAY) * 1000);
    await runLifeProjectWake(project, wake, base + 31 * DAY);
    expect(findLifeProject(project.id)!.status).toBe('exhausted');
    expect(getMissionContinuity(project.mission_id)!.status).toBe('expired');
    expect(modelRequests).toBe(0);
  });

  it('project completion rechecks old versions; a missing historical work never becomes an achieved mission', async () => {
    const project = activate(2);
    await runCognitiveProcessTick(base);
    const first = db.prepare('SELECT * FROM life_project_attempts WHERE ordinal=1').get() as LifeAttempt;
    writeFileSync(join(directory, 'artifacts', project.id, first.artifact_name!), '历史文件已被破坏');
    vi.setSystemTime((base + DAY) * 1000); reopen();
    await runCognitiveProcessTick(base + DAY);
    expect(findLifeProject(project.id)!.status).toBe('exhausted');
    expect(getMissionContinuity(project.mission_id)!.status).toBe('failed');
    expect(lifeProjectContext(42)).toContain('历史作品当前不可校验');
    expect((db.prepare("SELECT count(*) AS n FROM cognitive_events WHERE dedupe_key=?").get(`life-integrity:${project.id}`) as { n: number }).n).toBe(1);
    expect(modelRequests).toBe(2);
  });

  it('cross-minute mission ticks do not duplicate a life wake; legacy duplicates become waiting and preserve history', async () => {
    const project = activate();
    const first = listDueProcessWakes(base)[0]!;
    vi.setSystemTime((base + 61) * 1000);
    expect(runCognitiveContinuityTick(base + 61)).toEqual({ missionsWoken: 0, processesWoken: 0 });
    // Persist the exact pre-fix shape: another minute's generic mission wake.
    const old = requestProcessWake({ processId: first.processId, kind: 'strategist', scope: first.scope,
      wakeAt: base + 61, reason: 'mission_due' })!;
    await runCognitiveProcessTick(base + 61);
    expect(modelRequests).toBe(1);
    expect(listProcessCheckpointsForTest().get(first.wakeEventId)?.status).toBe('completed');
    expect(listProcessCheckpointsForTest().get(old.eventId)).toMatchObject({ status: 'waiting', outcomeEventIds: [] });
    expect(db.prepare('SELECT 1 FROM cognitive_events WHERE id=?').get(old.eventId)).toBeDefined();
    const pending = listPendingProcessWakes();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.wakeAt).toBe(findLifeProject(project.id)!.next_due_at);
    for (let hour = 1; hour <= 12; hour++) {
      const now = base + 61 + hour * 3600;
      vi.setSystemTime(now * 1000); reopen();
      expect(runCognitiveContinuityTick(now)).toEqual({ missionsWoken: 0, processesWoken: 0 });
      expect((await runCognitiveProcessTick(now, 1)).claimed).toBe(0);
    }
    expect(modelRequests).toBe(1); expect(listPendingProcessWakes()).toHaveLength(1);
  });

  it('more than twenty old not-due wakes cannot starve another process with a one-slot limit', async () => {
    const project = activate();
    await runCognitiveProcessTick(base);
    const oldIds: string[] = [];
    for (let index = 1; index <= 25; index++) {
      const now = base + index * 60; vi.setSystemTime(now * 1000);
      oldIds.push(requestProcessWake({ processId: `mission:${project.mission_id}`, kind: 'strategist',
        scope: { visibility: 'chat', chatId: 42 }, wakeAt: now, reason: 'mission_due' })!.eventId);
    }
    const now = base + 3600; vi.setSystemTime(now * 1000); reopen();
    const healthy = requestProcessWake({ processId: 'healthy-other-process', kind: 'strategist',
      scope: { visibility: 'chat', chatId: 42 }, wakeAt: now, reason: 'test' })!;
    expect((await runCognitiveProcessTick(now, 1)).claimed).toBe(1);
    const checkpoints = listProcessCheckpointsForTest();
    expect(checkpoints.get(healthy.eventId)?.status).toBe('waiting');
    for (const id of oldIds) expect(checkpoints.get(id)).toMatchObject({ status: 'waiting', outcomeEventIds: [] });
    expect(modelRequests).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM life_project_attempts').get()).toEqual({ n: 1 });
    expect(listPendingProcessWakes().filter(wake => wake.processId === `mission:${project.mission_id}`)).toHaveLength(1);
  });

  it('repairs an older same-minute future wake without aliasing it or running the next practice early', async () => {
    const project = activate();
    await runCognitiveProcessTick(base);
    const next = findLifeProject(project.id)!.next_due_at;
    // Simulate a legacy database whose only next wake is one second too early.
    const canonical = listPendingProcessWakes()[0]!;
    db.prepare('DELETE FROM cognitive_events WHERE id=?').run(canonical.wakeEventId);
    const old = requestProcessWake({ processId: canonical.processId, kind: 'strategist', scope: canonical.scope,
      wakeAt: next - 1, reason: 'legacy_future' })!;
    vi.setSystemTime((next - 1) * 1000); reopen();
    expect((await runCognitiveProcessTick(next - 1, 1)).claimed).toBe(0);
    expect(modelRequests).toBe(1);
    expect(listProcessCheckpointsForTest().get(old.eventId)?.status).toBe('waiting');
    expect(listPendingProcessWakes()).toHaveLength(1);
    expect(listPendingProcessWakes()[0]!.wakeAt).toBe(next);
    vi.setSystemTime(next * 1000);
    await runCognitiveProcessTick(next, 1);
    expect(modelRequests).toBe(2);
  });

  it('terminal settlement stops the process and retires both due and future duplicates without extra success receipts', async () => {
    const project = activate(1), initial = listDueProcessWakes(base)[0]!;
    requestProcessWake({ processId: initial.processId, kind: 'strategist', scope: initial.scope,
      wakeAt: base + 61, reason: 'old_future_duplicate' });
    await runCognitiveProcessTick(base);
    expect(findLifeProject(project.id)!.status).toBe('completed');
    expect(listPendingProcessWakes()).toEqual([]);
    const checkpoints = [...listProcessCheckpointsForTest().values()];
    expect(checkpoints.filter(row => row.status === 'completed')).toHaveLength(1);
    expect(checkpoints.filter(row => row.status === 'waiting')).toHaveLength(1);
    expect(db.prepare("SELECT count(*) AS n FROM cognitive_events WHERE type='cognitive_process_stopped'").get()).toEqual({ n: 1 });
    vi.setSystemTime((base + DAY) * 1000); reopen();
    expect(runCognitiveContinuityTick(base + DAY)).toEqual({ missionsWoken: 0, processesWoken: 0 });
    expect((await runCognitiveProcessTick(base + DAY)).claimed).toBe(0);
    expect(modelRequests).toBe(1);
  });

  it('invalid-account and disabled life wakes do not occupy a shared runtime slot', async () => {
    const project = activate();
    // Keep the general legacy selector permissive to exercise the life gate.
    config['EMOTION_CONTINUITY_ENABLED'] = false;
    config['BOT_TOKEN'] = '456:test';
    const healthy = requestProcessWake({ processId: 'healthy-new-account', kind: 'strategist',
      scope: { visibility: 'chat', chatId: 42 }, wakeAt: base, reason: 'test' })!;
    expect((await runCognitiveProcessTick(base, 1)).claimed).toBe(1);
    expect(listProcessCheckpointsForTest().has(healthy.eventId)).toBe(true);
    expect(findLifeProject(project.id)!.attempts_started).toBe(0);
    config['BOT_TOKEN'] = '123:test'; config['LIFE_PROJECT_ENABLED'] = false;
    const healthy2 = requestProcessWake({ processId: 'healthy-feature-off', kind: 'strategist',
      scope: { visibility: 'chat', chatId: 42 }, wakeAt: base, reason: 'test' })!;
    expect((await runCognitiveProcessTick(base, 1)).claimed).toBe(1);
    expect(listProcessCheckpointsForTest().has(healthy2.eventId)).toBe(true);
    expect(modelRequests).toBe(0);
  });

  it('a failed superseded-checkpoint transaction preserves the original pending history and cannot spend a request', async () => {
    const project = activate(), first = listDueProcessWakes(base)[0]!;
    requestProcessWake({ processId: first.processId, kind: 'strategist', scope: first.scope,
      wakeAt: base + 61, reason: 'old_duplicate' });
    db.exec(`CREATE TRIGGER reject_life_cleanup BEFORE INSERT ON cognitive_events
      WHEN NEW.type='cognitive_process_checkpoint' BEGIN SELECT RAISE(ABORT, 'fixture checkpoint unavailable'); END`);
    vi.setSystemTime((base + 120) * 1000);
    await expect(runCognitiveProcessTick(base + 120)).rejects.toThrow('life_superseded_checkpoint_unavailable');
    expect(listPendingProcessWakes()).toHaveLength(2);
    expect(findLifeProject(project.id)!.attempts_started).toBe(0); expect(modelRequests).toBe(0);
    db.exec('DROP TRIGGER reject_life_cleanup');
    await runCognitiveProcessTick(base + 120);
    expect(modelRequests).toBe(1); expect(listPendingProcessWakes()).toHaveLength(1);
  });

  it('future-wake persistence failure rolls back retirement, then repeated recovery is idempotent', async () => {
    const project = activate();
    await runCognitiveProcessTick(base);
    const next = findLifeProject(project.id)!.next_due_at;
    const canonical = listPendingProcessWakes()[0]!;
    db.prepare('DELETE FROM cognitive_events WHERE id=?').run(canonical.wakeEventId);
    const old = requestProcessWake({ processId: canonical.processId, kind: 'strategist', scope: canonical.scope,
      wakeAt: next - 1, reason: 'legacy_future' })!;
    db.exec(`CREATE TRIGGER reject_next_life_wake BEFORE INSERT ON cognitive_events
      WHEN NEW.type='cognitive_process_wake' BEGIN SELECT RAISE(ABORT, 'fixture next wake unavailable'); END`);
    vi.setSystemTime((base + 3600) * 1000);
    await expect(runCognitiveProcessTick(base + 3600)).rejects.toThrow('life_next_wake_unavailable');
    expect(listProcessCheckpointsForTest().has(old.eventId)).toBe(false);
    expect(listPendingProcessWakes().map(wake => wake.wakeEventId)).toEqual([old.eventId]);
    expect(modelRequests).toBe(1);
    db.exec('DROP TRIGGER reject_next_life_wake');
    await runCognitiveProcessTick(base + 3600);
    const count = db.prepare('SELECT count(*) AS n FROM cognitive_events').get();
    for (let repeat = 0; repeat < 5; repeat++) {
      reopen(); await runCognitiveProcessTick(base + 3600);
    }
    expect(db.prepare('SELECT count(*) AS n FROM cognitive_events').get()).toEqual(count);
    expect(listPendingProcessWakes()).toHaveLength(1);
    expect(listPendingProcessWakes()[0]!.wakeAt).toBe(next);
    expect(modelRequests).toBe(1);
  });
});
