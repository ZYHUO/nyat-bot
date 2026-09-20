#!/usr/bin/env env npx tsx
/**
 * 会话改动生产效果一览 —— 一把量完，不翻日志。
 *
 * 为什么需要它：这一轮（2026-09-21）连修了七处——频率治理、心流保句闸、
 * 思维链截断重试、链上游去重、ASI 假度量、bot 结构闸、架构占比。
 * 每一处都有单测和探针证明，但**生产效果**要等流量，而流量只在白天。
 * 于是每次都陷入"改了但说不出有没有用"。
 *
 * 这个脚本把七处的读数合成一张表。用法：
 *
 *   npx tsx scripts/session-report.mts          # 默认最近 3 天
 *   npx tsx scripts/session-report.mts 7        # 最近 7 天
 *
 * 读数取不到时**明说取不到**，不打印 0——0 和"没有数据"是两件事，
 * 把这个搞混是这个会话反复吃亏的地方。
 */
import { readFileSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';

const LOG = 'logs/app.log';
const DB = 'data/xxb.db';
const DAYS = Number(process.argv[2] ?? 3);
const sinceMs = Date.now() - DAYS * 86_400_000;
/** 部署后的窗口：这一轮的改动都是重启后生效的，混在一起看会看不出效果。 */
const deployMs = lastDeployMs();

// ── 日志侧 ────────────────────────────────────────────────────────────────
interface LogStats {
  inbound: number;
  heartDecision: number;
  heartFailed: number;
  emptyResponse: number;
  truncRetry: number;
  allExhausted: number;
  metaEvents: number;
  legacyExits: number;
  legacyDenoise: number;
  legacyReplyEngine: number;
  structuralIgnore: number;
  semanticDenoise: number;
  keepAddressed: number;
  envelopeBlock: number;
  budgetBlock: number;
  gapBlock: number;
  sendBudgetEnd: number;
  lines: number;
  windowStart: number;
  windowEnd: number;
  /** 部署后的行数/入站/心流失败等，单独一列 */
  afterDeploy: number;
  afterInbound: number;
  afterHeartFailed: number;
  afterHeartDecision: number;
  afterTruncRetry: number;
  afterKeepAddressed: number;
  afterStructuralIgnore: number;
  /** taskId → 该任务的投递条数，用来看"每任务发送分布" */
  taskSends: Map<string, number>;
}

/** 最后一次 "Bot started (polling)" 的时间戳 —— 这一轮的改动都是重启后生效的。 */
function lastDeployMs(): number {
  let last = 0;
  try {
    const fd = readFileSync(LOG, 'utf8');
    for (const line of fd.split('\n')) {
      if (!line.includes('Bot started (polling)')) continue;
      const m = /"time":(\d{13})/.exec(line.slice(0, 80));
      if (m) last = Math.max(last, Number(m[1]));
    }
  } catch {
    /* 读不到就算了，调用方会看到 0 */
  }
  return last;
}

function readLog(): LogStats {
  const st: LogStats = {
    inbound: 0, heartDecision: 0, heartFailed: 0, emptyResponse: 0, truncRetry: 0,
    allExhausted: 0, metaEvents: 0, legacyExits: 0, legacyDenoise: 0,
    legacyReplyEngine: 0, structuralIgnore: 0, semanticDenoise: 0, keepAddressed: 0,
    envelopeBlock: 0, budgetBlock: 0, gapBlock: 0, sendBudgetEnd: 0,
    lines: 0, windowStart: 0, windowEnd: 0,
    afterDeploy: 0, afterInbound: 0, afterHeartFailed: 0, afterHeartDecision: 0,
    afterTruncRetry: 0, afterKeepAddressed: 0, afterStructuralIgnore: 0,
    taskSends: new Map(),
  };
  let fd: string;
  try {
    fd = readFileSync(LOG, 'utf8');
  } catch {
    return st;
  }
  for (const line of fd.split('\n')) {
    if (!line.startsWith('{')) continue;
    const m = /"time":(\d{13})/.exec(line.slice(0, 80));
    if (!m) continue;
    const t = Number(m[1]);
    if (t < sinceMs) continue;
    if (t >= deployMs) st.afterDeploy++;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    st.lines++;
    if (!st.windowStart) st.windowStart = t;
    st.windowEnd = t;
    const msg = String(d['msg'] ?? '');
    // 失败原因在 err.message 里，不在 msg 里——"All labels exhausted" 和
    // "Empty response" 都是被 fallback 链包在 err 中上传的。只看 msg 会全得 0，
    // 而 0 和"没有数据"是两件事。
    const errMsg = String((d['err'] as { message?: string } | undefined)?.message ?? d['error'] ?? '');
    if (msg === 'message in') { st.inbound++; if (t >= deployMs) st.afterInbound++; }
    else if (msg === 'Heart decision') { st.heartDecision++; if (t >= deployMs) st.afterHeartDecision++; }
    else if (msg === 'heart LLM failed, fail-closed pass') { st.heartFailed++; if (t >= deployMs) st.afterHeartFailed++; }
    else if (errMsg.includes('All labels exhausted')) st.allExhausted++;
    else if (errMsg.includes('Empty response')) st.emptyResponse++;
    // 每个 label 只在第一次截断时打 info（不刷屏），后续走 debug。
    // 所以这个数是"有几个 label 被发现会截断"，不是"重试了几次"。
    else if (msg.includes('思维链吃光额度')) { st.truncRetry++; if (t >= deployMs) st.afterTruncRetry++; }
    else if (msg.startsWith('Meta ')) st.metaEvents++;
    else if (msg.startsWith('Pipeline complete')) {
      st.legacyExits++;
      if (msg.includes('denoise')) st.legacyDenoise++;
      if (msg.includes('floor') || msg.includes('heart=pass') || msg.includes('asleep')) st.legacyReplyEngine++;
    }
    else if (msg.includes('结构性忽略')) { st.structuralIgnore++; if (t >= deployMs) st.afterStructuralIgnore++; }
    else if (msg.includes('denoise silenced')) st.semanticDenoise++;
    else if (msg.includes('转 wait 保句')) { st.keepAddressed++; if (t >= deployMs) st.afterKeepAddressed++; }
    else if (msg.includes('BLOCKED by envelope')) st.envelopeBlock++;
    else if (msg.includes('BLOCKED by trench gate')) {
      const why = String(d['why'] ?? '');
      if (why === 'budget_spent') st.budgetBlock++;
      else if (why === 'just_spoke') st.gapBlock++;
    }
    else if (msg.includes('send budget exhausted')) st.sendBudgetEnd++;
    else if (msg === 'task delivery recorded') {
      const tid = String(d['taskId'] ?? '');
      if (!tid) continue;
      st.taskSends.set(tid, (st.taskSends.get(tid) ?? 0) + 1);
      // 部署后的任务单独一套 key（加前缀），免得跨窗口混在一起看不出效果
      if (t >= deployMs) st.taskSends.set(`@${tid}`, (st.taskSends.get(`@${tid}`) ?? 0) + 1);
    }
  }
  return st;
}

// ── SQLite 侧 ─────────────────────────────────────────────────────────────
interface DbStats {
  sends: number;
  sendsPrev: number;
  asiRows: number;
  asiMeasured: number;
  outcomes: number;
  /** 非空 = SQLite 没读到，上面的 0 一律读作"没有数据" */
  failed?: string;
  /** 最近一条 asi_final 非密的时间（ISO），用来看新代码有没有产出实测 */
  asiLatestMeasured?: string;
}

function readDb(): DbStats {
  const out: DbStats = { sends: 0, sendsPrev: 0, asiRows: 0, asiMeasured: 0, outcomes: 0 };
  try {
    // 不走 getDb()（那会连上生产库并跑迁移）；直接只读打开。
    const db = new Database(DB, { readonly: true, fileMustExist: true });
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceSec = nowSec - DAYS * 86_400;
    out.sends = (db.prepare('SELECT COUNT(*) n FROM self_replies WHERE ts >= ?').get(sinceSec) as { n: number }).n;
    out.sendsPrev = (db.prepare('SELECT COUNT(*) n FROM self_replies WHERE ts >= ? AND ts < ?').get(sinceSec - DAYS * 86_400, sinceSec) as { n: number }).n;
    const r = db.prepare(
      `SELECT COUNT(*) n, COUNT(asi_final) measured FROM reply_outcomes WHERE ts >= ?`,
    ).get(sinceSec) as { n: number; measured: number };
    out.asiRows = r.n;
    out.asiMeasured = r.measured;
    out.outcomes = r.n;
    const lm = db.prepare('SELECT MAX(ts) t FROM reply_outcomes WHERE asi_final IS NOT NULL').get() as { t: number | null };
    if (lm?.t) out.asiLatestMeasured = new Date(lm.t * 1000).toISOString().replace('T', ' ').slice(0, 16);
    db.close();
  } catch (err) {
    // 读不到必须留痕：静默的 0 会被读成"效果为 0"，那是这个会话吃亏最多的坑。
    out.failed = err instanceof Error ? err.message : String(err);
  }
  return out;
}

/**
 * 每任务发送分布。这是频率的真实指标——修复前 6 条以上的任务有 79 个
 * （最差一个 46 秒 12 条），修复后该尾巴应该消失。
 */
function printTaskDistribution(taskSends: Map<string, number>): void {
  const dump = (label: string, pick: (k: string) => boolean): void => {
    const vals = [...taskSends.entries()].filter(([k]) => pick(k)).map(([, v]) => v);
    if (vals.length === 0) {
      console.log(`  ${label}（没有数据）`);
      return;
    }
    const dist = new Map<number, number>();
    for (const n of vals) dist.set(n, (dist.get(n) ?? 0) + 1);
    const over6 = vals.filter((n) => n > 6).length;
    const parts = [...dist.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([k, v]) => `${k}条×${v}`)
      .join('  ');
    console.log(`  ${label}${parts}`);
    console.log(`    任务 ${vals.length} 个｜超过 6 条的 ${over6} 个   ← 修复后这项应该归零`);
  };
  if (taskSends.size === 0) {
    console.log('  每任务发送分布                （窗口内没有 task delivery 记录）');
    return;
  }
  dump('全窗口:  ', (k) => !k.startsWith('@'));
  dump('部署后:  ', (k) => k.startsWith('@'));
}

const st = readLog();
const db = readDb();
const pct = (n: number, d: number): string => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—');
const noData = st.lines === 0 && db.sends === 0;
if (db.failed) {
  console.log(`  ⚠️  SQLite 读取失败：${db.failed}`);
  console.log('     下面 SQLite 侧的 0 一律读作"没有数据"，不是"效果为 0"。\n');
}

console.log(`\n═══ 会话改动生产效果 · 最近 ${DAYS} 天 ═══\n`);
if (noData) {
  console.log('  ⚠️  窗口内没有任何数据（bot 可能在睡觉，或日志/库路径不对）。');
  console.log('     下面的 0 一律读作"没有数据"，不是"效果为 0"。\n');
}
if (st.windowStart) {
  const fmt = (t: number): string => new Date(t).toISOString().replace('T', ' ').slice(0, 16);
  console.log(`日志窗口: ${fmt(st.windowStart)} → ${fmt(st.windowEnd)} UTC  (${st.lines.toLocaleString()} 行)`);
}
console.log('');

if (deployMs > 0) {
  const fmt = (t: number): string => new Date(t).toISOString().replace('T', ' ').slice(11, 16);
  console.log(`最近一次部署: ${new Date(deployMs).toISOString().replace('T', ' ').slice(0, 16)} UTC` +
    `（此后 ${st.afterDeploy.toLocaleString()} 行日志 / ${st.afterInbound} 条入站）`);
  if (st.afterInbound === 0) {
    console.log('  ⚠️  部署后还没有入站消息（bot 可能在睡觉）。下面"部署后"一列的 0 读作');
    console.log('      「还没有数据」，不是「效果为 0」。修复本身由单测+探针证明。');
  }
  console.log('');
}

console.log('── 1. 发言频率 ──');
console.log(`  本群发送 (self_replies)      ${db.sends}`);
console.log(`  上一个等长窗口                ${db.sendsPrev}` +
  (db.sendsPrev > 0 ? `   ${db.sends <= db.sendsPrev ? '↓' : '↑'} ${pct(Math.abs(db.sends - db.sendsPrev), db.sendsPrev)}` : ''));
console.log('    （注：这个对比跨了库清理/重启，只作参考；真正的频率看下面"每任务发送分布"）');
console.log(`  包络拦截 (L1 Wall)           ${st.envelopeBlock}`);
console.log(`  计数额度拦截 (6/h)           ${st.budgetBlock}`);
console.log(`  最小间隔拦截                 ${st.gapBlock}`);
console.log(`  每任务预算耗尽收尾           ${st.sendBudgetEnd}`);
printTaskDistribution(st.taskSends);
console.log('');

console.log('── 2. 心流健康 ──');
console.log(`  心流裁决                      ${st.heartDecision}`);
console.log(`  LLM 失败 (fail-closed)        ${st.heartFailed}  ${pct(st.heartFailed, st.heartDecision)}   部署后 ${st.afterHeartFailed}`);
console.log(`    ├─ All labels exhausted     ${st.allExhausted}  ${pct(st.allExhausted, Math.max(1, st.heartFailed))} of failures`);
console.log(`    └─ 空正文                   ${st.emptyResponse}`);
console.log(`  发现会截断的 label             ${st.truncRetry}   部署后 ${st.afterTruncRetry}   （每个只记第一次，不刷屏）`);
console.log(`  保句闸 (被叫到 → wait)        ${st.keepAddressed}   部署后 ${st.afterKeepAddressed}`);
console.log('');

console.log('── 2b. topic-scan 抽取率（低产 = LLM 在空转）──');
{
  let ticks = 0; let chats = 0; let observed = 0;
  try {
    const fd = readFileSync(LOG, 'utf8');
    for (const line of fd.split('\n')) {
      if (!line.includes('Topic scan tick')) continue;
      const m = /"time":(\d{13})/.exec(line.slice(0, 80));
      if (!m || Number(m[1]) < sinceMs) continue;
      let d: Record<string, unknown>;
      try { d = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      ticks++;
      chats += Number(d['chats'] ?? 0);
      observed += Number(d['observed'] ?? 0);
    }
  } catch { /* 读不到就留 0，配合上面的提示读作没有数据 */ }
  if (ticks === 0) {
    console.log('  窗口内没有 Topic scan tick');
  } else {
    const rate = chats > 0 ? observed / chats : 0;
    console.log(`  tick ${ticks} 次｜扫群 ${chats}｜抽出标签 ${observed}  ${pct(observed, chats)}`);
    if (chats > 0 && rate < 0.15) {
      console.log('  ⚠️  低于 15% —— 要么群真的冷清，要么 LLM 在空转。看日志里的');
      console.log('      "claude: 空正文"（思维链吃光 max_tokens）与 topic-scan 的低产告警。');
      console.log('      2026-09-21 实测：修 maxTokens 之前 4.5%（2040 扫 / 91 抽），');
      console.log('      修之后同一次 tick observed 0 → 10、零截断。');
    }
  }
}
console.log('');

console.log('── 3. 架构占比 ──');
console.log(`  入站                          ${st.inbound}`);
console.log(`  Meta 路径事件                 ${st.metaEvents}`);
console.log(`  legacy processPipeline 出口   ${st.legacyExits}  ${pct(st.legacyExits, st.inbound)}`);
console.log(`    ├─ bot 降噪                 ${st.legacyDenoise}`);
console.log(`    └─ 回复引擎走到出口         ${st.legacyReplyEngine}  ${pct(st.legacyReplyEngine, st.inbound)}   ← 这个数越低越好`);
console.log(`  Meta 侧结构性忽略 bot         ${st.structuralIgnore}   部署后 ${st.afterStructuralIgnore}`);
console.log(`  Meta 侧语义降噪 bot           ${st.semanticDenoise}`);
console.log('');

console.log('── 4. ASI 自评（假度量修复）──');
console.log(`  窗口内 reply_outcomes         ${db.asiRows}`);
console.log(`  其中真测到（asi_final 非空） ${db.asiMeasured}  ${pct(db.asiMeasured, db.asiRows)}`);
console.log(`  未测到（写 NULL，不写假值）   ${db.asiRows - db.asiMeasured}`);
if (db.asiLatestMeasured) {
  console.log(`  最近一条实测: ${db.asiLatestMeasured}` +
    (deployMs > 0 && new Date(db.asiLatestMeasured).getTime() < deployMs
      ? '   ← 在部署前，新代码还没产出实测' : ''));
}
if (db.asiRows > 0 && db.asiMeasured === 0) {
  console.log('  ⚠️  全 NULL —— 要么没采样到，要么 rubric 调用仍在失败。看日志里的');
  console.log('      "claude: 空正文" 与 "ASI: rubric 解析失败"。');
}
console.log('');
console.log('── 判读 ──');
console.log('  · 频率：发送数应低于上一个等长窗口；三道拦截的计数是"在干活"的证据。');
console.log('  · 心流：LLM 失败率应低于 25%（修复前的实测值）；截断重试数 > 0 说明那类故障真在发生。');
console.log('  · 架构：legacy 回复引擎那一行是"老架构还剩多少"的唯一指标。');
console.log('  · ASI：实测率 > 0 才说明 rubric 不再是常量；NULL 是诚实，不是故障。');
console.log('');
process.exit(0);
