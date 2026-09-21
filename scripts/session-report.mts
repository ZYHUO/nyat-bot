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
  /** 最后一条 awake 处理证据的时间戳（0 = 没有） */
  lastAwakeMs: number;
  /** `Meta path: asleep` 的行数（睡眠期排队，不是 awake 处理） */
  metaAsleep: number;
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
    afterDeploy: 0, afterInbound: 0, afterHeartFailed: 0, afterHeartDecision: 0, lastAwakeMs: 0, metaAsleep: 0,
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
    // 最后一条"醒着在处理"的证据。睡眠期消息走 `Meta path: asleep` 排队，
    // 不算 awake 处理——拿它当证据会以为功能在跑，其实只是消息到了。
    //
    // **必须独立成句，不能并进下面的 else-if 链**：2026-09-21 我把它写成
    // `if (...) {...} else if (msg === 'Heart decision')`，于是 `Heart decision`
    // 恰好也在 AWAKE_MARKERS 里 → 第二个 if 恒真 → 后面的 else if 永远不执行 →
    // `心流裁决` 恒为 0，而 `LLM 失败` 照常计数（它不在 AWAKE_MARKERS 里）。
    // 报告于是显示"0 次裁决、1253 次失败"——一个看着像数据、其实是断链的数字。
    if (msg === 'Meta path: asleep') st.metaAsleep++;
    if (msg !== 'Meta path: asleep' && AWAKE_MARKERS.has(msg)) {
      st.lastAwakeMs = Math.max(st.lastAwakeMs, t);
    }
    if (msg === 'Heart decision') { st.heartDecision++; if (t >= deployMs) st.afterHeartDecision++; }
    else if (msg === 'heart LLM failed, fail-closed pass') { st.heartFailed++; if (t >= deployMs) st.afterHeartFailed++; }
    else if (errMsg.includes('All labels exhausted')) st.allExhausted++;
    else if (errMsg.includes('Empty response')) st.emptyResponse++;
    // 每个 label 只在第一次截断时打 info（不刷屏），后续走 debug。
    // 所以这个数是"有几个 label 被发现会截断"，不是"重试了几次"。
    else if (msg.includes('思维链吃光额度')) { st.truncRetry++; if (t >= deployMs) st.afterTruncRetry++; }
    // **结构性忽略必须排在 `startsWith('Meta ')` 之前**。
    // 2026-09-21：它的日志原文是 `Meta path: bot 未称呼本喵，结构性忽略（不烧心流）`——
    // 以 'Meta ' 开头，于是先被上面那个分支吃掉，structuralIgnore 永远是 0。
    // 实测 awake 窗口里它打了 6 次，报告却印 0。和 round 41 那条 else-if 断链同族：
    // **宽泛的前缀分支排在具体分支前面，具体的就永远数不到**。
    if (msg.includes('结构性忽略')) { st.structuralIgnore++; if (t >= deployMs) st.afterStructuralIgnore++; }
    else if (msg.includes('denoise silenced')) st.semanticDenoise++;
    else if (msg.startsWith('Pipeline complete')) {
      st.legacyExits++;
      if (msg.includes('denoise')) st.legacyDenoise++;
      if (msg.includes('floor') || msg.includes('heart=pass') || msg.includes('asleep')) st.legacyReplyEngine++;
    }
    else if (msg.includes('转 wait 保句')) { st.keepAddressed++; if (t >= deployMs) st.afterKeepAddressed++; }
    else if (msg.includes('BLOCKED by envelope')) st.envelopeBlock++;
    // `Meta ...` 兜底必须放在**最后**：它是个宽泛前缀，排在具体分支前面会把
    // `Meta path: ...结构性忽略` / `Meta path: denoise silenced ...` 一起吃掉
    // （2026-09-21：两个数都印 0，实际分别是 171 和 37）。
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
    // 兜底放最后：见上面那条注释。宽泛前缀必须让具体分支先匹配。
    else if (msg.startsWith('Meta ')) st.metaEvents++;
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
  /** 主动发言（cron/unified-tick，trigger_uid=0） */
  sendsProactive?: number;
  /** 有触发对象的回复 */
  sendsTriggered?: number;
  /** 非空 = SQLite 没读到，上面的 0 一律读作"没有数据" */
  failed?: string;
  /** 最近一条 asi_final 非密的时间（ISO），用来看新代码有没有产出实测 */
  asiLatestMeasured?: string;
  /** asi_final 非空的行数（含修复前写进去的假测量） */
  asiNonNull?: number;
  /** 最近一条真测到（rubric 不全等于中性默认）的时间 */
  asiLatestReal?: string;
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
    // 主动（无触发）与被动（有触发）分开：self_replies 有三个写入方
    // （deliver / host-api / unified-tick），第三个是 cron 主动发言，trigger_uid=0。
    // 混在一起数，"回复频率"就不是回复频率了。
    const split = db.prepare(
      `SELECT CASE WHEN trigger_uid = 0 THEN 'proactive' ELSE 'triggered' END kind, COUNT(*) n
         FROM self_replies WHERE ts >= ? GROUP BY kind`,
    ).all(sinceSec) as Array<{ kind: string; n: number }>;
    out.sendsProactive = split.find((r) => r.kind === 'proactive')?.n ?? 0;
    out.sendsTriggered = split.find((r) => r.kind === 'triggered')?.n ?? 0;
    // **COUNT(asi_final) 不是"真测到"**：旧代码把中性默认值当测量结果写进去，
    // 于是 `asi_final IS NOT NULL` 里混着 2242 行一模一样的 77.0 / warmth 0.5。
    // 2026-09-21 修完之后未测到的写 NULL，但**历史行救不回来**——
    // 拿 COUNT(asi_final) 当实测率，会把修复前的假测量算成真的。
    //
    // 判据改成"rubric 五列不全等于中性默认值"：那才是模型真吐了分的样子。
    const NEUTRAL = 'rubric_social_presence = 0.5 AND rubric_warmth = 0.5 AND rubric_competence = 0.5 AND rubric_appropriateness = 0.5 AND rubric_uncanny_risk = 0.2';
    const r = db.prepare(
      `SELECT COUNT(*) n,
              COUNT(asi_final) nonNull,
              SUM(CASE WHEN asi_final IS NOT NULL AND NOT (${NEUTRAL}) THEN 1 ELSE 0 END) measured
         FROM reply_outcomes WHERE ts >= ?`,
    ).get(sinceSec) as { n: number; nonNull: number; measured: number };
    out.asiRows = r.n;
    out.asiMeasured = r.measured;
    out.asiNonNull = r.nonNull;
    out.outcomes = r.n;
    const lm = db.prepare('SELECT MAX(ts) t FROM reply_outcomes WHERE asi_final IS NOT NULL').get() as { t: number | null };
    if (lm?.t) out.asiLatestMeasured = new Date(lm.t * 1000).toISOString().replace('T', ' ').slice(0, 16);
    // 最近一条**真测到**的时间
    const lm2 = db.prepare(`SELECT MAX(ts) t FROM reply_outcomes WHERE asi_final IS NOT NULL AND NOT (${NEUTRAL})`).get() as { t: number | null };
    if (lm2?.t) out.asiLatestReal = new Date(lm2.t * 1000).toISOString().replace('T', ' ').slice(0, 16);
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

/**
 * 只在**醒着处理人类消息**时出现的痕迹。
 *
 * 刻意不含 `Pipeline complete (denoise: bot ...)` / `Bot message classified`：
 * 这两条在睡眠期也照跑（bot 消息不走睡眠闸），拿它们当"功能在跑"的证据会误判。
 * 也不含 cron 的 tick——cron 睡不睡都跑。
 */
const AWAKE_MARKERS: ReadonlySet<string> = new Set([
  'Heart decision',
  'Meta heart: pass',
  'task delivery recorded',
  'host sendText',
]);

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

if (st.lastAwakeMs > 0) {
  const gapH = (Date.now() - st.lastAwakeMs) / 3_600_000;
  const fmtAwake = new Date(st.lastAwakeMs).toISOString().replace('T', ' ').slice(0, 16);
  console.log(`最后一条 awake 处理证据: ${fmtAwake} UTC（${gapH.toFixed(1)} 小时前）`);
  if (gapH > 1) {
    console.log(`  ⚠️  bot 已沉睡 ${gapH.toFixed(1)} 小时。这段时间里到的消息全部走`);
    console.log('      `Meta path: asleep` 排队醒来再处理——**它们不是功能在跑的证据**。');
    console.log('      下面"部署后"一列的 0 一律读作"还没有 awake 数据"。');
  }
  console.log('');
}

// **重启低谷提示。** round 87 实测：重启后前 5 分钟的 `all candidates skipped`
// 是稳定期的 5 倍、`Circuit breaker tripped` 是 10 倍——因为熔断/冷却键活在
// Redis 里跨重启不过期（已修，但重启后的几十秒内真失败的 provider 还会重新熔断）。
// 所以"部署后"那一列在头几分钟里读到的不是稳态，是低谷。
// 不写这一句，一段刚重启后的糟糕数字会被当成"修复没生效"。
if (deployMs > 0 && Date.now() - deployMs < 10 * 60_000) {
  const mins = ((Date.now() - deployMs) / 60_000).toFixed(0);
  console.log(`⚠️  距上次重启才 ${mins} 分钟——"部署后"那一列现在是**重启低谷**，不是稳态`);
  console.log('    （熔断键已改为启动时清理，但真在失败的 provider 几十秒内会重新熔断）。');
  console.log('    想看稳态效果，等 10 分钟以上再跑，或看全窗口那一列。');
  console.log('');
}

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
console.log(`  发言总数 (self_replies)      ${db.sends}`);
console.log(`    其中有触发（真回复）        ${db.sendsTriggered ?? 0}`);
console.log(`    其中主动（cron 冒泡）       ${db.sendsProactive ?? 0}`);
// 真正的"频率"是**比率**：每 100 条入站消息里 bot 说几句。
// 绝对数随群活跃度浮动，比率才是用户说的"日常都有点过高频率"那个东西。
if (st.inbound > 0 && db.sends > 0) {
  const per100 = (db.sends / st.inbound) * 100;
  console.log(`  每 100 条入站发言            ${per100.toFixed(1)} 句   ← 这才是"频率"`);
  if (per100 > 20) {
    console.log('    ⚠️ 高于 20% —— bot 说的话接近群里每五条就有一条是它。');
    console.log('       （判据是经验值：正常群聊里真人互答占比也就在这个量级。）');
  }
}
if (db.sendsPrev > 0) {
  console.log(`  上一个等长窗口                ${db.sendsPrev}` +
    `   ${db.sends <= db.sendsPrev ? '↓' : '↑'} ${pct(Math.abs(db.sends - db.sendsPrev), db.sendsPrev)}`);
  console.log('    （注：这个对比跨过库清理/重启时会虚高，只作参考；看上面那个比率。）');
}
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

console.log('── 2c. cron 产出率（跑了但什么都没产出 = 静默失败）──');
{
  // 每一行是 (失败 的日志串, 成功 的日志串 | null, 说明)。
  // 2026-09-21 这一轮靠手工数这些对，找出六个"跑了但零产出"的 cron。
  // 固化成报告，下次不用再靠人想起来看。
  //
  // 成功串为 null 的行只报失败计数——那种调用成功时**不写日志**（长期记忆写入
  // 就是：成了静默默，只有失败那一句）。给它配一个假的成功串会算出假的产出率，
  // 而假比率比没有比率更糟。
  const PAIRS: Array<[string, string | null, string]> = [
    // round 130 的教训：CodeAct 任务崩溃率必须有个出口。round 126 我让
    // getExecutionAudit 取不到 audit，每个 CodeAct 任务必崩，而这个会话的报告
    // 看了十几轮没印过这一项——我一直在看 judge 链成功率、频率、蒸馏产出率，
    // 没有一个数字会告诉我"所有 subagent 任务都死了"。
    // ok 那一路用 'CodeAct task start' 自己兜（没有单独的完成日志），
    // 崩溃 = start - 未崩，用下面的 cNoFail 之外的算法算。
    ['CodeAct job failed', 'CodeAct task start', 'CodeAct 任务'],
    ['dreaming output unparseable', 'dreaming consolidated', 'dreaming 整合'],
    ['distill output unparseable', 'episode distilled', 'episode 蒸馏'],
    // 三个出口都要数：失败 / 判过不用接 / 派发了续答。
    // 2026-09-21：原来只配了失败和派发，算出 10.7% 的假比率——
    // "判过、结论是不用接话"这一路（绝大多数）没有日志，分母漏了它，
    // 失败率被放大了近 10 倍，看起来这功能几乎全是坏的。
    ['post-task follow-up batch failed', null, '任务后追话·失败'],
    ['post-task judge: no follow-up', null, '任务后追话·判过不接'],
    ['post-task continuation dispatched', null, '任务后追话·派发了'],
    ['deep-reflection: LLM failed', 'deep-reflection tick complete', '深度反思'],
    ['Memory write failed', null, '长期记忆写入'],
    ['heart LLM failed', 'Heart decision', '心流裁决'],
  ];
  const counts = new Map<string, number>();
  try {
    const fd = readFileSync(LOG, 'utf8');
    for (const line of fd.split('\n')) {
      if (!line.startsWith('{')) continue;
      const m = /"time":(\d{13})/.exec(line.slice(0, 80));
      if (!m || Number(m[1]) < sinceMs) continue;
      let d: Record<string, unknown>;
      try { d = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const msg = String(d['msg'] ?? '');
      const post = Number(m[1]) >= deployMs;
      for (const [fail, ok] of PAIRS) {
        if (msg.includes(fail)) {
          counts.set(fail, (counts.get(fail) ?? 0) + 1);
          if (post) counts.set(`@${fail}`, (counts.get(`@${fail}`) ?? 0) + 1);
        }
        if (ok && msg.includes(ok)) {
          counts.set(ok, (counts.get(ok) ?? 0) + 1);
          if (post) counts.set(`@${ok}`, (counts.get(`@${ok}`) ?? 0) + 1);
        }
      }
    }
  } catch { /* 读不到就全 0，配合上面的提示读作没有数据 */ }
  let any = false;
  const THREE_WAY = '任务后追话';
  const seen3 = new Set<string>();
  for (const [fail, ok, label] of PAIRS) {
    if (label.startsWith(THREE_WAY)) { seen3.add(fail); continue; }
    const f = counts.get(fail) ?? 0;
    const o = ok ? (counts.get(ok) ?? 0) : 0;
    if (f === 0 && o === 0) continue;
    any = true;
    if (!ok) {
      console.log(`  ${label.padEnd(16)} 失败 ${String(f).padStart(5)}   （成功不写日志，无产出率）`);
      continue;
    }
    const total = f + o;
    const rate = total > 0 ? o / total : 0;
    // 部署后的样本先算出来——**⚠️ 要由它说了算，不是全窗口**。
    //
    // round 121 的教训：全窗口含三段已修完的事故（整段外网中断约 1 小时 LLM 必败、
    // 并发风暴期 round 81-93、7864 断额期），于是 `深度反思 25.2% ⚠️` 一直在报，
    // 而等长窗口实测是 50-75%、部署后 75%。**修完的事故不该继续计息。**
    //
    // 所以判据改成：全窗口过低 **且** 部署后样本够（≥10）且也过低，才标 ⚠️。
    // 部署后样本不够时标 `（部署后样本不足）` 而不是 ⚠️——那是"还不知道"，
    // 不是"有问题"。
    const pf0 = counts.get(`@${fail}`) ?? 0;
    const po0 = ok ? (counts.get(`@${ok}`) ?? 0) : 0;
    const ptot = pf0 + po0;
    const bad = total >= 20 && rate < 0.5 && ptot >= 10 && (po0 / ptot) < 0.5;
    const unsure = total >= 20 && rate < 0.5 && !bad;
    const mark = bad ? '   ⚠️ 过低' : (unsure ? '   （部署后样本不足，全窗口含已修事故）' : '');
    console.log(`  ${label.padEnd(16)} 成功 ${String(o).padStart(5)}｜失败 ${String(f).padStart(5)}  产出率 ${(rate * 100).toFixed(1).padStart(5)}%${mark}`);
    // 部署后单独一行。**这一行是 round 71 加的，因为窗口混了修复前后的数据：**
    // distiller 全窗口 32.5%（看着仍 ⚠️），而 round 47 部署之后实际是 **83.3%**
    // （130 成 / 26 败）。修复明明生效了，全窗口比率却在说还没修好。
    const pf = counts.get(`@${fail}`) ?? 0;
    const po = ok ? (counts.get(`@${ok}`) ?? 0) : 0;
    if (pf + po > 0) {
      const prate = po / (pf + po);
      console.log(`  ${' '.repeat(16)} 部署后 成功 ${String(po).padStart(3)}｜失败 ${String(pf).padStart(3)}  产出率 ${(prate * 100).toFixed(1).padStart(5)}%`
        + `${pf + po < 20 ? '   （样本少，只作方向）' : ''}`);
    }
  }

  // 三出口组：失败 / 判过不用接 / 派发了续答。三个都数才算得出真比率。
  {
    const bad = counts.get('post-task follow-up batch failed') ?? 0;
    const noop = counts.get('post-task judge: no follow-up') ?? 0;
    const sent = counts.get('post-task continuation dispatched') ?? 0;
    const total = bad + noop + sent;
    if (total > 0) {
      any = true;
      const failRate = (bad / total) * 100;
      console.log(`  任务后追话        判过不接 ${String(noop).padStart(5)}｜派发 ${String(sent).padStart(5)}｜失败 ${String(bad).padStart(5)}  失败率 ${failRate.toFixed(1).padStart(5)}%`);
      console.log('    （三个出口都数。2026-09-21 之前只数失败+派发，算出 10.7% 的假产出率——');
      console.log('      「判过、结论是不用接话」那一路没有日志，分母漏了绝大多数情况。）');
      if (total >= 20 && failRate > 50) console.log('    ⚠️ 失败率过高');
      // **CodeAct 任务成败**（round 130 的教训）。
    //
    // round 126 我在 createHostApi 的 return 上包了一层 Proxy 加计数器，
    // 让 getExecutionAudit 取不到 audit，`audit.hasContract()` 抛
    // `Cannot read properties of undefined`——**每个 CodeAct 任务必崩**。
    // 而这个会话的报告看了十几轮，从没印过这一项：我一直在看 judge 链成功率
    // （92%）、频率（9.8/100）、蒸馏产出率，没有一个数字会告诉我
    // "所有 subagent 任务都死了"。
    //
    // 所以把它印出来，且 **100% 失败时直接喊**。这是 round 26（失败率要三个
    // 出口都数）在任务层的同一次补课。
    const cStart = counts.get('CodeAct task start') ?? 0;
    const cFail = counts.get('@CodeAct job failed') ?? 0;
    const cAllFail = counts.get('CodeAct job failed') ?? 0;
    if (cStart > 0) {
      const crashed = cFail / cStart;
      console.log(`  CodeAct 任务            起 ${cStart}｜部署后崩 ${cFail}｜全窗口崩 ${cAllFail}  崩溃率 ${((cAllFail / cStart) * 100).toFixed(0)}%`);
      if (cAllFail / cStart >= 0.5) {
        console.log('    🚨 CodeAct 崩溃率 ≥50%——**所有需要 subagent 的回复都是坏的**。');
        console.log('       优先查这个，别看别的指标。round 130 就是这样崩了四轮没人发现。');
      }
    }
    // 部署后单独算。round 71 的教训：全窗口把修复前后的数据混在一个比率里，
      // 修复生效之后它继续报警——distiller 就这样被报了十个小时（实际 83.3%）。
      // 任务后追话是同一形状：全窗口 71%，而 round 40 那次部署之后实测是 **0%**。
      const pBad = counts.get('@post-task follow-up batch failed') ?? 0;
      const pNoop = counts.get('@post-task judge: no follow-up') ?? 0;
      const pSent = counts.get('@post-task continuation dispatched') ?? 0;
      const pTotal = pBad + pNoop + pSent;
      if (pTotal > 0) {
        console.log(`    部署后 判过不接 ${String(pNoop).padStart(3)}｜派发 ${String(pSent).padStart(3)}｜失败 ${String(pBad).padStart(3)}  失败率 ${((pBad / pTotal) * 100).toFixed(1).padStart(5)}%`);
      }
    }
  }
  if (!any) console.log('  （窗口内这些 cron 都没有日志）');
  // 全窗口比率会**把修复前后的数据混在一起**，这是 round 71 抓到的一次误判：
  // distiller 全窗口 33.7%（印着 ⚠️ 过低），而 round 47 那次部署之后实测是 83.3%
  // （130 成 / 26 败）——修复明明生效了，全窗口比率却在说还没修好。
  // 想知道某个修复的效果，要从**那次**部署算起，不是从最近一次。
  console.log('  （全窗口比率混了修复前后的数据。要验某个修复，从那次的部署时刻算起——');
  console.log('     上面"部署后"一行只覆盖最近一次重启。）');
  // topic-scan 单列：它的"产出"是 tick 日志里的 observed 字段，不是另一条消息
  console.log('  （topic-scan 的产出率见上一节）');
  console.log('');
  console.log('  ⚠️ 的判据：≥20 次尝试而产出率 <50%。2026-09-21 实测修之前的形状：');
  console.log('     dreaming 805 次 0%、distiller 473/73=13%、post-task 失败 2104 次、');
  console.log('     topic-scan 2040 次调用只抽 91 个标签（4.5%）。全是"跑了但什么都没产出"。');

// ── 机器可读输出（给 scripts/xcheck-report.mts 当左端用）─────────────────
// 人看的排版里有 ├─、｜、百分比、全角空格，任何外部解析器都是脆的。
// 所以这里让报告自己吐一份 key=value：xcheck 拿它和"直接 grep 日志"对，
// 抓的是"报告的匹配漏了某条日志"（round 41 / round 57 两个恒 0 计数器）。
if (process.argv.includes('--kv')) {
  const kv: Array<[string, number]> = [
    ['heart_decision', st.heartDecision],
    ['heart_failed', st.heartFailed],
    ['all_exhausted', st.allExhausted],
    ['empty_response', st.emptyResponse],
    ['trunc_retry', st.truncRetry],
    ['meta_events', st.metaEvents],
    ['legacy_exits', st.legacyExits],
    ['legacy_denoise', st.legacyDenoise],
    ['legacy_reply_engine', st.legacyReplyEngine],
    ['structural_ignore', st.structuralIgnore],
    ['semantic_denoise', st.semanticDenoise],
    ['keep_addressed', st.keepAddressed],
    ['envelope_block', st.envelopeBlock],
    ['trench_gate_block', st.budgetBlock + st.gapBlock],
    ['send_budget_end', st.sendBudgetEnd],
    ['meta_asleep', st.metaAsleep],
    ['inbound', st.inbound],
  ];
  // 三个出口的 cron 对（2c 节）——用同一份 counts，别重算
  for (const [fail, ok, label] of PAIRS) {
    kv.push([`cron_fail:${label}`, counts.get(fail) ?? 0]);
    if (ok) kv.push([`cron_ok:${label}`, counts.get(ok) ?? 0]);
  }
  for (const [k, v] of kv) console.log(`${k}=${v}`);
}
console.log('');

// 2d) 实时 LLM 调用计数——给上面的失败数一个分母。
//
// 为什么需要它：日志里 `Label failed, trying next` 一天 3499 条，听着像世界末日，
// 但没有分母就不知道那是 3499/4000 还是 3499/40000。此前这个报告只报绝对数，
// 而**没有分母的绝对数没法判断严重程度**——这是"痕迹不是事实"的又一例。
//
// 计数器是进程内的（重启归零），所以它量的正好是"部署后"那段窗口，
// 和上面的 after-deploy 列同一个时间范围。
{
  try {
    const res = await fetch('http://127.0.0.1:3001/metrics', { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    const byOutcome = new Map<string, number>();
    for (const line of text.split('\n')) {
      const m = /^llm_requests_total\{[^}]*outcome="([^"]+)"\}\s+(\d+)/.exec(line);
      if (m) byOutcome.set(m[1]!, (byOutcome.get(m[1]!) ?? 0) + Number(m[2]));
    }
    const ok = byOutcome.get('ok') ?? 0;
    const err = [...byOutcome.entries()].filter(([k]) => k !== 'ok').reduce((a, [, v]) => a + v, 0);
    const total = ok + err;
    if (total === 0) {
      console.log('── 2d. 实时 LLM 调用（部署后）──');
      console.log('  计数器还是 0——进程刚起，或者还没打过 LLM。');
      console.log('');
    } else {
      const rate = (err / total) * 100;
      console.log('── 2d. 实时 LLM 调用（部署后，进程内计数）──');
      console.log(`  总调用 ${total}｜成功 ${ok}｜失败 ${err}  失败率 ${rate.toFixed(1)}%`);
      if (byOutcome.size > 1) {
        const parts = [...byOutcome.entries()].map(([k, v]) => `${k}=${v}`).join('  ');
        console.log(`  按 outcome: ${parts}`);
      }
      // realtime-learn：区分"没跑"和"跑了但没什么可记"
    const rlRun = [...text.matchAll(/^realtime_learn_runs_total\{[^}]*\}\s+(\d+)/gm)].reduce((a, m) => a + Number(m[1]), 0);
    const rlSaved = [...text.matchAll(/^realtime_learn_episodes_total\{[^}]*\}\s+(\d+)/gm)].reduce((a, m) => a + Number(m[1]), 0);
    if (rlRun > 0 || rlSaved > 0) {
      console.log(`  realtime-learn: 跑 ${rlRun} 次｜抽出 episode ${rlSaved} 条`);
      if (rlRun > 0 && rlSaved === 0) {
        console.log('    （跑了但一条都没抽出来 = 模型判定这些来回不值得记，不是没跑。'
          + '2026-09-21 探针直接调 learnFromReply 传一段有内容的来回也返回 0，确认是这个原因。）');
      }
    }
    // 并发闸的排队时长：分开"闸在帮倒忙"和"provider 真坏了"。
    // round 95 等长窗口对比五项失败全差，三种解释分不清，就缺这个数。
    const waitTotal = [...text.matchAll(/^llm_concurrency_wait_ms_total\{[^}]*\}\s+(\d+)/gm)].reduce((a, m) => a + Number(m[1]), 0);
    const waits = [...text.matchAll(/^llm_concurrency_waits_total\{[^}]*\}\s+(\d+)/gm)].reduce((a, m) => a + Number(m[1]), 0);
    const slow = [...text.matchAll(/^llm_concurrency_slow_waits_total\{[^}]*\}\s+(\d+)/gm)].reduce((a, m) => a + Number(m[1]), 0);
    if (waits > 0) {
      console.log(`  并发闸排队            等过 ${waits} 次｜总等 ${(waitTotal / 1000).toFixed(1)}s｜均 ${(waitTotal / waits).toFixed(0)}ms｜>2s 的 ${slow} 次`);
      const to = [...text.matchAll(/^llm_concurrency_wait_timeout_total\{[^}]*\}\s+(\d+)/gm)].reduce((a, m) => a + Number(m[1]), 0);
      if (to > 0) {
        console.log(`    其中 ${to} 次等超过 1500ms 上限被放行（超发一次 429 好过等掉半个超时预算）`);
      }
      if (waits >= 10 && waitTotal / waits > 1500) {
        console.log('    ⚠️  平均排队 >1.5s——撞的是 maxTimeoutMs 不是 429。');
        console.log('        （已改为等超 1500ms 就放行；这个数仍高说明 AI_MAX_CONCURRENCY_PER_ACCOUNT 该调大。）');
      } else if (waits >= 10) {
        console.log('    （排队不久而失败仍多 → 是 provider 自己在坏，不是闸的问题。）');
      }
    }
    // 工具层调用计数（round 126 加）："广告了但从未成功调用过"从此是个数字，
  // 不用 grep 一整天日志人肉比对。round 125 那份 79 广告 / 14 调用 / 3 坏的清单
  // 就是这么数出来的，数了半小时。
  const toolOk = [...text.matchAll(/^host_tool_calls_total\{[^}]*tool="([^"]+)"[^}]*outcome="ok"\}\s+(\d+)/gm)];
  const toolErr = [...text.matchAll(/^host_tool_calls_total\{[^}]*tool="([^"]+)"[^}]*outcome="error"\}\s+(\d+)/gm)];
  if (toolOk.length + toolErr.length > 0) {
    const errMap = new Map(toolErr.map((m) => [m[1]!, Number(m[2])]));
    console.log('  工具调用（host api，部署后）:');
    for (const m of toolOk) {
      const e = errMap.get(m[1]!) ?? 0;
      const o = Number(m[2]);
      console.log(`    ${m[1]!.padEnd(20)} ok=${String(o).padStart(4)} err=${String(e).padStart(4)}  成功率 ${((o / (o + e)) * 100).toFixed(0)}%`);
      errMap.delete(m[1]!);
    }
    for (const [t, e] of errMap) console.log(`    ${t.padEnd(20)} ok=   0 err=${String(e).padStart(4)}  ← 全败`);
  }
  // 等待重试的成败：等过一次之后是救回来了、还是仍然全冷却。
    // 没这两个数，"我加了个重试"和"这个重试有用"看起来一模一样。
    const wrOk = [...text.matchAll(/^llm_wait_retry_total\{[^}]*outcome="ok"[^}]*\}\s+(\d+)/gm)].reduce((a, m) => a + Number(m[1]), 0);
    const wrCold = [...text.matchAll(/^llm_wait_retry_total\{[^}]*outcome="still_cooling"[^}]*\}\s+(\d+)/gm)].reduce((a, m) => a + Number(m[1]), 0);
    if (wrOk > 0 || wrCold > 0) {
      const tot = wrOk + wrCold;
      console.log(`  全链冷却等最短醒来重试  救回 ${wrOk}｜等完仍全冷却 ${wrCold}  救回率 ${((wrOk / tot) * 100).toFixed(0)}%`);
      if (tot >= 10 && wrOk / tot < 0.3) {
        console.log('    ⚠️  救回率偏低——等的十几秒大多白等。考虑缩短上界（现 15s）或直接不等。');
      }
    }
    if (total >= 20 && rate > 25) {
        console.log('  ⚠️ 失败率偏高——但注意这是"每次尝试"的口径，一次 callWithFallback 可能试多跳。');
        console.log('     看上面 2. 节的心流失败率（那是"最终有没有拿到结果"的口径）判断实际影响。');
      }
      console.log('');
    }
  } catch {
    console.log('── 2d. 实时 LLM 调用（部署后）──');
    console.log('  读不到 http://127.0.0.1:3001/metrics（METRICS_ENABLED 或端口不对）——跳过。');
    console.log('');
  }
}

console.log('── 3. 架构占比 ──');
console.log(`  入站                          ${st.inbound}`);
console.log(`  Meta 路径事件                 ${st.metaEvents}` +
  (st.inbound > 0 ? `   ${(st.metaEvents / st.inbound).toFixed(2)} 条/入站` : ''));
console.log(`  legacy processPipeline 出口   ${st.legacyExits}  ${pct(st.legacyExits, st.inbound)}`);
console.log(`    ├─ bot 降噪                 ${st.legacyDenoise}`);
console.log(`    └─ 回复引擎走到出口         ${st.legacyReplyEngine}  ${pct(st.legacyReplyEngine, st.inbound)}   ← 这个数越低越好`);
console.log(`  Meta 侧结构性忽略 bot         ${st.structuralIgnore}   部署后 ${st.afterStructuralIgnore}`);
console.log(`  Meta 侧语义降噪 bot           ${st.semanticDenoise}`);
console.log('');

console.log('── 4. ASI 自评（假度量修复）──');
console.log(`  窗口内 reply_outcomes         ${db.asiRows}`);
console.log(`  asi_final 非空                ${db.asiNonNull ?? 0}   ← **不是**实测率：修复前把中性默认值当测量写了进去`);
console.log(`  其中真测到（rubric 有真分）   ${db.asiMeasured}  ${pct(db.asiMeasured, db.asiRows)}`);
console.log(`  未测到                        ${db.asiRows - (db.asiNonNull ?? 0)}`);
if (db.asiLatestReal) console.log(`  最近一条真测到: ${db.asiLatestReal}`);
if (db.asiLatestMeasured && !db.asiLatestReal) {
  console.log(`  （最近一条 asi_final 非空是 ${db.asiLatestMeasured}，但那是中性默认值，不是真测量）`);
}
if (db.asiRows > 0 && db.asiMeasured === 0) {
  console.log('  ⚠️  一条真测量都没有 —— 要么没采样到，要么 rubric 调用仍在失败。看日志里的');
  console.log('      "claude: 空正文" 与 "ASI: rubric 解析失败"。');
}
console.log('');
console.log('── 判读 ──');
console.log('  · 频率：看"每 100 条入站发言"那个比率，不是绝对数。三道拦截的计数是"在干活"的证据。');
console.log('  · 架构：Meta 事件/入站 正常在 1.2-1.5（heart 裁决 + dispatch + attention 各一轮）。');
console.log('    明显更高说明同一回合在 Meta 层反复转——那通常是 lost arm race / coalesce hold 在堆。');
console.log('  · 心流：LLM 失败率应低于 25%（修复前的实测值）；截断重试数 > 0 说明那类故障真在发生。');
console.log('  · 架构：legacy 回复引擎那一行是"老架构还剩多少"的唯一指标。');
console.log('  · ASI：实测率 > 0 才说明 rubric 不再是常量；NULL 是诚实，不是故障。');
console.log('');
}

process.exit(0);

