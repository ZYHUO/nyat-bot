import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface HoldoutTask {
  id: string;
  chatId: number;
  domain: string;
  goal: string;
  /** kind of artifact the host acceptance checks (never shown to the agent as the answer). */
  artifactKind: 'json_sum' | 'csv_digest' | 'text_marker';
  payload: { numbers?: number[]; answer: number };
}

/** 未见任务集:与训练/蒸馏数据无交集的合成计算任务,答案由 host 独立计算。 */
export function buildHoldoutSet(): HoldoutTask[] {
  return [
    { id: 'holdout-arith-01', chatId: 1, domain: 'arithmetic', goal: '计算 17+29+41 的和并写入 result.json', artifactKind: 'json_sum', payload: { numbers: [17, 29, 41], answer: 87 } },
    { id: 'holdout-arith-02', chatId: 1, domain: 'arithmetic', goal: '计算 8*7+6 的值并写入 result.json', artifactKind: 'json_sum', payload: { numbers: [8, 7, 6], answer: 62 } },
    { id: 'holdout-ledger-01', chatId: 1, domain: 'ledger', goal: '三行记账 63、45、42，求总额并写入 ledger.csv。注意: 题面里没有总额这个数字，必须自己加出来', artifactKind: 'csv_digest', payload: { answer: 150 } },
    { id: 'holdout-ledger-02', chatId: 1, domain: 'ledger', goal: '订单原价 120，退货 31，求净额并写入 ledger.csv。注意: 题面里没有净额这个数字，必须自己算出来', artifactKind: 'csv_digest', payload: { answer: 89 } },
    { id: 'holdout-marker-01', chatId: 1, domain: 'marker', goal: '往 report.txt 写一行"本组共 7 人参加"(必须包含该数字)', artifactKind: 'text_marker', payload: { answer: 7 } },
    { id: 'holdout-marker-02', chatId: 1, domain: 'marker', goal: '往 report.txt 写一行"本次共 13 项议题"(必须包含该数字)', artifactKind: 'text_marker', payload: { answer: 13 } },
  ];
}

function seedDb(db: Database.Database, tasks: HoldoutTask[], seedMemory: { skills: string[]; experience: { content: string; verified: boolean }[] }): void {
  db.exec(readFileSync('migrations/0054_episodes_experience.sql', 'utf8'));
  try { db.exec(readFileSync('migrations/0057_experience_verify.sql', 'utf8')); } catch { /* optional */ }
  try { db.exec(readFileSync('migrations/0061_experience_share.sql', 'utf8')); } catch { /* optional */ }
  try { db.exec(readFileSync('migrations/0071_skills.sql', 'utf8')); } catch { /* optional */ }
  try { db.exec(readFileSync('migrations/0072_task_evidence.sql', 'utf8')); } catch { /* optional */ }
  try { db.exec(readFileSync('migrations/0075_experience_source.sql', 'utf8')); } catch { /* optional */ }
  const now = Math.floor(Date.now() / 1000);
  for (const s of seedMemory.skills) {
    try {
      db.prepare(`INSERT INTO skills (name, tier, trigger_when, steps, pitfalls, summary, tags, origin_task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(s, 'big', 'when computing', '["compute carefully"]', '["check twice"]', s, '["holdout"]', 'seed', now);
    } catch { /* skills table may be absent in minimal env */ }
  }
  for (const e of seedMemory.experience) {
    try {
      db.prepare(`INSERT INTO experience_entries (kind, content, tags, source_episode_id, source_assessment, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('trick', e.content, '["holdout"]', 0, e.verified ? 'verified' : 'unverified', e.verified ? 1 : 0, now);
    } catch {
      try {
        db.prepare(`INSERT INTO experience_entries (kind, content, tags, source_episode_id, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run('trick', e.content, '["holdout"]', 0, now);
      } catch { /* experience table absent */ }
    }
  }
  void tasks;
}

/**
 * 留出评测:同一任务集 × 记忆开关(ON=注入 skill/experience, OFF=裸跑)。
 * 度量的是「记忆是否提升产物验收通过率」,不是模型智商。
 * Agent 执行由调用方注入(runOne) —— 本模块只负责任务集、种子库与评分,
 * 避免把被测执行写死在评测器里(可重复、可换执行器)。
 */
export interface HoldoutReport {
  kind: 'holdout_memory_ablation_not_agi_benchmark';
  memoryOn: { passed: number; failed: number };
  memoryOff: { passed: number; failed: number };
  delta: number;
  cases: { id: string; domain: string; memoryOn: string; memoryOff: string }[];
}

export async function runHoldoutEvaluation(runOne: (task: HoldoutTask, memoryOn: boolean) => Promise<'verified' | 'failed' | 'unverified'>): Promise<HoldoutReport> {
  const tasks = buildHoldoutSet();
  const cases: HoldoutReport['cases'] = [];
  let onPassed = 0;
  let offPassed = 0;
  for (const t of tasks) {
    const on = await runOne(t, true);
    const off = await runOne(t, false);
    if (on === 'verified') onPassed++;
    if (off === 'verified') offPassed++;
    cases.push({ id: t.id, domain: t.domain, memoryOn: on, memoryOff: off });
  }
  return {
    kind: 'holdout_memory_ablation_not_agi_benchmark',
    memoryOn: { passed: onPassed, failed: tasks.length - onPassed },
    memoryOff: { passed: offPassed, failed: tasks.length - offPassed },
    delta: onPassed - offPassed,
    cases,
  };
}

export function createIsolatedSeed(seedMemory: { skills: string[]; experience: { content: string; verified: boolean }[] }): { dbPath: string; db: Database.Database } {
  const dir = mkdtempSync(join(tmpdir(), 'nyat-holdout-'));
  const dbPath = join(dir, 'holdout.db');
  const db = new Database(dbPath);
  seedDb(db, buildHoldoutSet(), seedMemory);
  return { dbPath, db };
}
