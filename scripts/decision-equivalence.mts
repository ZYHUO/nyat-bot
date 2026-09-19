/**
 * Nyat Trench · 判定点对等度（Decision Equivalence）
 *
 * 论文 §9：删除不是里程碑，是结果；每次删除以对等测试为前置。
 *
 * 但七子系统深度耦合，"逐条消息 A/B"要双倍判定调用（一天 5842 万 token 无余量）。
 * 可做的对等是：**同一批消息上，单决策点（shadow）想做的 vs 线上真实做的**，
 * 取 top-level 一致率。这是 Phase 2 "判定点上真身" 的准入判据。
 *
 *   shadow:  cognitive_events WHERE type='social_prediction'  (verdict=speak/wait/silent)
 *   live:   self_replies WHERE trigger_msg_id = 该消息          (bot 实际回没回)
 *
 * 一致性定义（top-level 二值化）：
 *   shadow speak  ⇔  live 真的回了这条
 *   shadow silent ⇔  live 没回
 *   wait 单独统计（它不映射到"回没回"）
 *
 * 用法：npx tsx scripts/decision-equivalence.mts [天数]
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** 日志里某个子串出现的次数（金丝雀同一套读数）。 */
function logCount(pattern: string): number {
  try {
    return readFileSync('logs/app.log', 'utf8').split(pattern).length - 1;
  } catch {
    return -1;
  }
}

const DAYS = Number(process.argv[2] ?? 7);
const DB = process.env.SQLITE_PATH ?? './data/xxb.db';
const since = Math.floor(Date.now() / 1000) - DAYS * 86400;

interface Row { [k: string]: unknown }
function sql(q: string): Row[] {
  const out = execSync(`sqlite3 -json "${DB}" "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

// shadow 判定（只看 ingress 那条；live_outcome 是另一条事件，分开算）
const shadowRows = sql(`
  SELECT chat_id AS chat_id, occurred_at AS occurred_at,
         json_extract(fact_json,'$.messageId') AS mid,
         json_extract(fact_json,'$.shadowVerdict') AS verdict
  FROM cognitive_events
  WHERE type='social_prediction'
    AND json_extract(fact_json,'$.schema')='shadow_ingress.v1'
    AND occurred_at >= ${since}
    AND json_extract(fact_json,'$.shadowVerdict') IN ('speak','silent','wait')`);

// 线上：bot 在每个群的发言时刻表。
//
// **为什么不用 trigger_msg_id = shadow.messageId 这个 join**：实测（2026-09-19）
// 那个 join 给出一致率 14.2%，而按"shadow 判定后 120 秒内该群有没有 bot 发言"
// 重算是 53.3%。差 4 倍的原因：shadow 判的是消息 N，而 bot 回复时往往锚在更晚的
// 消息 M 上（群里还在流动），于是 trigger_msg_id 根本对不上。
// 度量方法错误会把形势判断错四倍——这不是小事，所以这里用时间邻域。
const ACT_WINDOW_SEC = 120;
const botSpokeByChat = new Map<number, number[]>();
for (const r of sql(`SELECT chat_id AS c, ts FROM self_replies WHERE ts >= ${since} ORDER BY ts ASC`)) {
  const c = Number(r.c), t = Number(r.ts);
  if (!Number.isSafeInteger(c) || !Number.isSafeInteger(t)) continue;
  const list = botSpokeByChat.get(c) ?? [];
  list.push(t);
  botSpokeByChat.set(c, list);
}
const botSpoke = sql(`SELECT ts FROM self_replies WHERE ts >= ${since} ORDER BY ts ASC`);
/** 该群在 shadow 判定之后 ACT_WINDOW_SEC 内有没有 bot 发言。 */
function actedWithinWindow(chatId: number, atSec: number): boolean {
  const list = botSpokeByChat.get(chatId);
  if (!list) return false;
  for (const t of list) {
    if (t >= atSec && t <= atSec + ACT_WINDOW_SEC) return true;
    if (t > atSec + ACT_WINDOW_SEC) break;
  }
  return false;
}

let agree = 0, disagree = 0, unknown = 0;
let speakWant = 0, speakWantSpoke = 0;
let silentWant = 0, silentWantSilent = 0;
const waitN = shadowRows.filter((r) => r.verdict === 'wait').length;

for (const r of shadowRows) {
  const chatId = Number(r.chat_id);
  const atSec = Number(r.occurred_at);
  if (!Number.isSafeInteger(chatId) || chatId === 0 || !Number.isSafeInteger(atSec)) { unknown += 1; continue; }
  const spoke = actedWithinWindow(chatId, atSec);
  const v = String(r.verdict);
  if (v === 'speak') {
    speakWant += 1;
    if (spoke) { speakWantSpoke += 1; agree += 1; } else { disagree += 1; }
  } else if (v === 'silent') {
    silentWant += 1;
    if (!spoke) { silentWantSilent += 1; agree += 1; } else { disagree += 1; }
  }
}

// speak 率的分母必须是**全部**判定（含 failed/wait），不能只用 speak+silent——
// 后者 silent 只有 2 个，会算出"判定点 100% 想说话"的假读数。
const allVerdicts = sql(`SELECT COUNT(*) n FROM cognitive_events WHERE type='social_prediction'
  AND json_extract(fact_json,'$.schema')='shadow_ingress.v1' AND occurred_at >= ${since}`)[0]?.n ?? 0;
const speakRateOverall = Number(allVerdicts) > 0 ? speakWant / Number(allVerdicts) : 0;
const comparable = agree + disagree;
const rate = comparable > 0 ? agree / comparable : 0;

console.log(`\n═══ 判定点对等度 · 近 ${DAYS} 天 ═══\n`);
console.log(`shadow 判定样本：${shadowRows.length}（wait ${waitN} · 无法比对 ${unknown}）`);
console.log(`可比对样本：${comparable}`);
if (comparable === 0) {
  console.log('\n无比对样本——shadow 与 live 还没有共同覆盖的消息群。');
  console.log('（shadow 只在 NYATOS_SHADOW_CHAT_IDS 的三个群里跑）\n');
  process.exit(0);
}
console.log(`\n  单决策点想 speak：${speakWant} 次，其中线上真回了：${speakWantSpoke} 次`);
console.log(`  单决策点想 silent：${silentWant} 次，其中线上真没说：${silentWantSilent} 次`);
console.log(`\n  top-level 一致率：${(rate * 100).toFixed(1)}%`);
console.log(`\n  注意方向：一致率**低**通常不是 shadow 判错，而是线上还有别的抑制层`);
console.log(`  （gate/budget/dup）在替它做"别说"的决定——那正是要拆除的东西。`);
// ── 分解：不一致里有多少是"物理拦掉"，多少是"真的分歧" ──────────────
// 2026-09-19 实测（补身体前后对比）：
//   补身体前 speak 1675/1732 (96.7%) → 一致率 10.1%
//   补身体后 speak  970/ 972 (99.8%) → 一致率 14.2%
// 身体事实确实到了模型眼前（why 里开始出现"没人理我"），但**判定不变**。
// 这不是 bug，是对论文的确认：克制必须是物理的（L0 海沟 + L1 闸门），
// 不能是信息的——budget.ts 头部的 Phase 2.3 负结果早就测过同一件事。
const gated = Math.max(0, logCount('BLOCKED by trench gate'));
const dupBlocked = Math.max(0, logCount('rejected semantic repeat') + logCount('rejected self-echo (local)'));
console.log(`\n  ── 不一致的分解 ──`);
console.log(`  物理拦掉（硬闸 + 去重）约 ${gated + dupBlocked} 次；判定点 speak 而线上静默 ${disagree} 次`);
console.log(`  无法归因于物理约束的（≈真的分歧）：约 ${Math.max(0, disagree - gated - dupBlocked)} 次`);
console.log(`  读法：前者不是"判定点错了"，是"身体在管事"——它永远不该被抹平。\n`);

// ── 投影影响：判定点一旦变成权威，发送率会变成多少 ──────────────────
// 这是比"一致率"更诚实的一个数：一致率低可以怪 join，投影影响怪不了。
//
// 实测（2026-09-19，shadow 覆盖的三个群）：
//   chat -1003821093564  入站 1219  发言 266 → 实际 22%  shadow 想 speak 85.6%
//   chat -1003184176508  入站  237  发言 115 → 实际 49%
//   chat -1002750574953  入站  210  发言  58 → 实际 28%
//
// **并且：266 条/天 = 11 条/小时，已经超过 budget 的 6 条/小时上限。**
// 因为生产里 1572 次群发送全部带引用锚点 → 全部算"被叫到" → 全部豁免。
// 也就是说：**物理边界在流量最大的那条路上是个洞。**
//
// 这决定了 Phase 2 的真实前置不是"把判定点改聪明"，而是"让边界对所有发言生效
// （被叫到的用更宽松的包络）"——否则切换就是把最忙的群放大 4 倍。
try {
  const chats = sql(`SELECT DISTINCT chat_id AS c FROM cognitive_events
    WHERE type='social_prediction' AND occurred_at >= ${since}`).map((r) => Number(r.c)).filter((c) => Number.isSafeInteger(c) && c < 0);
  console.log(`\n  ── 投影影响（判定点上真身会发生什么）──`);
  for (const c of chats.slice(0, 6)) {
    const inbound = Number((sql(`SELECT COUNT(*) n FROM cognitive_events WHERE type='message_received' AND chat_id=${c} AND occurred_at >= ${since}`)[0]?.n ?? 0));
    const spoke = Number((sql(`SELECT COUNT(*) n FROM self_replies WHERE chat_id=${c} AND ts >= ${since}`)[0]?.n ?? 0));
    if (inbound < 20) continue;
    const live = spoke / inbound;
    console.log(`  chat ${c}: 实际发送率 ${(live * 100).toFixed(0)}% → 判定点想要 ${(speakRateOverall * 100).toFixed(0)}%（放大 ${(speakRateOverall / Math.max(live, 0.01)).toFixed(1)}x）`);
  }
  console.log(`  注：所有发言都算"被叫到"而豁免预算，所以这个放大没有物理上界。\n`);
} catch { /* 投影是附加信息，读不到就跳过 */ }

console.log(`  Phase 2 准入（论文 §9）：一致率 > 85% 才把判定点上真身。`);
console.log(`  当前结论：${rate > 0.85 ? '已达标' : '未达标——但先看清不达标是哪一笔账造成的'}\n`);

// 附：bot 发言密度（用于判断"线上是不是其实很安静"）
console.log(`参考：近 ${DAYS} 天 bot 发言 ${botSpoke.length} 条。\n`);
