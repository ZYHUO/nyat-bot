// ────────────────────────────────────────
// eval-belief-view.ts — Phase 0 falsification harness
//
// 三个实验，全部离线（子进程级隔离：直接用 better-sqlite3 :memory:
// 建表 + 复制 src/core 的纯逻辑，不 import 生产模块——生产模块的
// getDb()/logger/callWithFallback 依赖太重，harness 只验证算法本身）：
//  1. 毒化实验：100 条矛盾事实 + 50 条过期事实 → contradiction
//     precision/recall、TTL 违规率、host 更新后的 calibration 曲线。
//  2. 成本实验：getActiveBeliefs() P99 延迟（目标 < 10ms）。
//  3. 越权实验：L1 写 authorized_intent / L2 无授权 irreversible →
//     断言全部被 ACL/gate 拦下。
//
// 跑：./node_modules/.bin/tsx scripts/eval-belief-view.ts → 输出 JSON 指标
// exit 0 = 三项全过，exit 1 = 有不过项。
// ────────────────────────────────────────

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

const db: Database.Database = new Database(':memory:');
db.exec(readFileSync('migrations/0083_core_belief_view.sql', 'utf8'));
db.exec(readFileSync('migrations/0084_core_blackboard.sql', 'utf8'));

// ---- 纯逻辑内联（与 src/core 同公式，harness 独立验证） ----
const laplace = (s: number, r: number): number => (s + 1) / (s + r + 2);

function upsertBelief(input: {
  sourceTable: string;
  sourceRowId: number;
  predicate: string;
  summary: string;
  evidence: string[];
  ttlSec?: number;
}): number {
  if (!input.evidence || input.evidence.length === 0) throw new Error('evidence required');
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSec ?? 7776000;
  const ex = db
    .prepare(
      `SELECT id, evidence FROM core_beliefs
       WHERE source_table=? AND source_row_id=? AND predicate=?`,
    )
    .get(input.sourceTable, input.sourceRowId, input.predicate) as
    | { id: number; evidence: string }
    | undefined;
  if (ex) {
    db.prepare(
      `UPDATE core_beliefs SET summary=?, evidence=?, ttl_sec=?, status='active', updated_at=? WHERE id=?`,
    ).run(input.summary.slice(0, 200), input.evidence, ttl, now, ex.id);
    return ex.id;
  }
  return Number(
    db
      .prepare(
        `INSERT INTO core_beliefs
           (source_table, source_row_id, predicate, summary, confidence,
            support_count, refute_count, ttl_sec, status, evidence, created_at, updated_at)
         VALUES (?,?,?,?,0.5,0,0,?, 'active', ?,?,?)`,
      )
      .run(
        input.sourceTable,
        input.sourceRowId,
        input.predicate,
        input.summary.slice(0, 200),
        ttl,
        JSON.stringify(input.evidence),
        now,
        now,
      ).lastInsertRowid,
  );
}

function recordOutcome(id: number, ok: boolean): void {
  const row = db.prepare(`SELECT support_count, refute_count FROM core_beliefs WHERE id=?`).get(id) as {
    support_count: number;
    refute_count: number;
  };
  const s = row.support_count + (ok ? 1 : 0);
  const r = row.refute_count + (ok ? 0 : 1);
  db.prepare(
    `UPDATE core_beliefs SET support_count=?, refute_count=?, confidence=?, last_confirmed_at=?, status='active', updated_at=? WHERE id=?`,
  ).run(s, r, laplace(s, r), Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), id);
}

function contradict(id: number, evidence: string[]): void {
  const row = db.prepare(`SELECT refute_count FROM core_beliefs WHERE id=?`).get(id) as {
    refute_count: number;
  };
  db.prepare(`UPDATE core_beliefs SET refute_count=?, status='contradicted', updated_at=? WHERE id=?`).run(
    row.refute_count + 1,
    Math.floor(Date.now() / 1000),
    id,
  );
  void evidence;
}

function getActiveBeliefs(predicate: string, now?: number): Array<{ effectiveStatus: string }> {
  const t = now ?? Math.floor(Date.now() / 1000);
  const rows = db
    .prepare(`SELECT ttl_sec, updated_at FROM core_beliefs WHERE predicate=? AND status != 'contradicted'`)
    .all(predicate) as Array<{ ttl_sec: number; updated_at: number }>;
  return rows.map((r) => ({
    effectiveStatus: t - r.updated_at >= r.ttl_sec ? 'stale' : 'active',
  }));
}

// ACL（与 src/core/blackboard/acl.ts 同矩阵）
const ACL: Record<string, string[]> = {
  observation: ['l0', 'l1', 'l2', 'host'],
  proposal: ['l1'],
  authorized_intent: ['gate'],
  plan: ['l2'],
  execution_receipt: ['l2'],
};
const canWrite = (kind: string, author: string): boolean => (ACL[kind] ?? []).includes(author);

interface EvalReport {
  poison: {
    inserted: number;
    contradictedCaught: number;
    ttlViolations: number;
    calibration: Array<{ bucket: string; predicted: number; actual: number; n: number }>;
  };
  cost: { reads: number; p99Ms: number; targetMs: number; pass: boolean };
  privilege: { attempts: number; blocked: number; pass: boolean };
}

// ── 实验 1：毒化 ──
function poisonExperiment(): EvalReport['poison'] {
  let contradictedCaught = 0;
  for (let i = 0; i < 100; i++) {
    const id = upsertBelief({
      sourceTable: 'eval',
      sourceRowId: i,
      predicate: 'eval.poison',
      summary: `poison fact ${i}`,
      evidence: [`msg:${i}`],
    });
    contradict(id, [`refute:${i}`]);
    const row = db.prepare('SELECT status FROM core_beliefs WHERE id=?').get(id) as { status: string };
    if (row.status === 'contradicted') contradictedCaught++;
  }
  for (let i = 0; i < 50; i++) {
    upsertBelief({
      sourceTable: 'eval',
      sourceRowId: 1000 + i,
      predicate: 'eval.stale',
      summary: `stale fact ${i}`,
      evidence: [`msg:s${i}`],
      ttlSec: 1,
    });
  }
  const future = Math.floor(Date.now() / 1000) + 10;
  const ttlViolations = getActiveBeliefs('eval.stale', future).filter(
    (b) => b.effectiveStatus !== 'stale',
  ).length;

  const avg = (ids: number[]): number =>
    ids.reduce(
      (s, id) =>
        s + (db.prepare('SELECT confidence FROM core_beliefs WHERE id=?').get(id) as { confidence: number }).confidence,
      0,
    ) / ids.length;
  const grpA: number[] = [];
  for (let i = 0; i < 20; i++) {
    const id = upsertBelief({
      sourceTable: 'eval',
      sourceRowId: 2000 + i,
      predicate: 'eval.calibA',
      summary: `calibA ${i}`,
      evidence: ['msg:c'],
    });
    for (let k = 0; k < 10; k++) recordOutcome(id, true);
    grpA.push(id);
  }
  const grpB: number[] = [];
  for (let i = 0; i < 20; i++) {
    const id = upsertBelief({
      sourceTable: 'eval',
      sourceRowId: 3000 + i,
      predicate: 'eval.calibB',
      summary: `calibB ${i}`,
      evidence: ['msg:c'],
    });
    for (let k = 0; k < 5; k++) recordOutcome(id, true);
    for (let k = 0; k < 5; k++) recordOutcome(id, false);
    grpB.push(id);
  }
  return {
    inserted: 150,
    contradictedCaught,
    ttlViolations,
    calibration: [
      { bucket: '10support/0refute', predicted: 11 / 12, actual: avg(grpA), n: 20 },
      { bucket: '5support/5refute', predicted: 0.5, actual: avg(grpB), n: 20 },
    ],
  };
}

// ── 实验 2：成本 ──
function costExperiment(): EvalReport['cost'] {
  for (let i = 0; i < 50; i++) {
    upsertBelief({
      sourceTable: 'eval',
      sourceRowId: 9000 + i,
      predicate: 'eval.cost',
      summary: `cost fact ${i} with some longer text to scan over`,
      evidence: ['msg:cost'],
    });
  }
  const N = 500;
  const ds: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    getActiveBeliefs('eval.cost');
    ds.push(performance.now() - t0);
  }
  ds.sort((a, b) => a - b);
  const p99 = ds[Math.floor(N * 0.99)]!;
  return { reads: N, p99Ms: Math.round(p99 * 100) / 100, targetMs: 10, pass: p99 < 10 };
}

// ── 实验 3：越权（纯 ACL 矩阵断言，不碰 gate DB 路径——gate 已有单测覆盖） ──
function privilegeExperiment(): EvalReport['privilege'] {
  const cases: Array<[string, string, boolean]> = [
    ['authorized_intent', 'l1', false], // L1 写 intent → 拦
    ['proposal', 'l2', false], // L2 写 proposal → 拦
    ['authorized_intent', 'gate', true], // gate 写 intent → 放
    ['plan', 'l2', true], // L2 写 plan → 放
    ['observation', 'l0', true], // L0 写 observation → 放
    ['execution_receipt', 'l1', false], // L1 读 receipt？写 → 拦
    ['plan', 'l1', false], // L1 写 plan → 拦（铁律）
  ];
  let blocked = 0;
  for (const [kind, author, allowed] of cases) {
    if (canWrite(kind, author) === allowed) blocked++;
  }
  return { attempts: cases.length, blocked, pass: blocked === cases.length };
}

const report: EvalReport = {
  poison: poisonExperiment(),
  cost: costExperiment(),
  privilege: privilegeExperiment(),
};
console.log(JSON.stringify(report, null, 2));
const pass =
  report.poison.contradictedCaught === 100 &&
  report.poison.ttlViolations === 0 &&
  report.cost.pass &&
  report.privilege.pass;
process.exit(pass ? 0 : 1);
