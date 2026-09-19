// ────────────────────────────────────────
// Nyat Trench · L2 反射（Reflex）——Echo，全系统唯一的学习
// ────────────────────────────────────────
//
// 论文 docs/plans/2026-09-19-nyat-trench.md §3.2 机制三
//
// 这是整个架构唯一"会学"的一层，因此也是唯一需要被审计的一层。它做三件事：
//
//   1. **确定性回填**：主动发言（trigger_uid=0）的 self_replies 行有 98.7%
//      永远是 outcome='unknown'（实测 3,337 行）。原因不是缺观察器——outcome.ts
//      的 pending 闭合器一直在跑——而是**写入方缺漏**：主动发言从不进 pending。
//      本模块用 bot_interactions（chat_id/uid/ts/mid/reply_to_mid）做一次纯 SQL
//      回扫，把"有没有人接"补上。零 LLM、零 token。
//
//   2. **标量 E**：每群一个回声标量，硬钳 [0.05, 0.90]。
//         E ← clamp(E + 0.15·(y − E), 0.05, 0.90)
//      E_max=0.90 是刻意的：允许底气，不给免检。
//
//   3. **脉冲进海床**：被接住 → 什么都不做（发送时已泄压）；
//      被无视/插砸 → pulseForUnheard，让气压积攒。
//
// **单点写入**：E 的唯一写入方是本模块；P 的唯一增量方也是本模块。
// 没有第二个 setter（论文 §3.2 三条铁律之一）。

import { getDb } from '../db/sqlite.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';
import { closeSelfActOutcome } from '../tracking/self-history.js';
import { pulseForUnheard } from '../nyatos/trench.js';

/** 回声标量的硬界。 */
export const E_MIN = 0.05;
export const E_MAX = 0.90;
const E_INIT = 0.45;
const E_LR = 0.15;

/** 观察窗：一条主动发言发出后，给它这么久等人接。 */
const OBSERVE_WINDOW_SEC = 360;
/** 回填一次最多处理多少行，防止一次扫太久。 */
const BACKFILL_BATCH = 200;
/**
 * 回扫多久以内的主动发言。
 *
 * 必须远大于观察窗：第一版用 6 分钟，结果线上最近的主动发言是 122 分钟前的，
 * 扫描窗里永远没东西——回填器"接了线但是死的"，E 永远停在 0.45。
 * 取 24h：既覆盖真实节奏（主动发言本来就稀疏），又不会把陈账翻出来。
 */
const BACKFILL_LOOKBACK_SEC = 24 * 3600;
/** 至少这么多条人类消息之后仍无人接，才敢判 ignored（避免太早下结论）。 */
const MIN_HUMAN_MSGS_FOR_IGNORED = 3;

const KEY_E = 'xxb:trench:e:';

function echoEnabled(): boolean {
  try { return env().ECHO_ENABLED === true; } catch { return false; }
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** 读回声。读失败 → 中立值 0.45（不是 0：一个读不到回声的群不该被惩罚）。 */
export async function readEcho(chatId: number): Promise<number> {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return E_INIT;
  try {
    const raw = await getRedis().get(KEY_E + chatId);
    return clamp(Number(raw === null ? E_INIT : raw), E_MIN, E_MAX);
  } catch {
    return E_INIT;
  }
}

/**
 * 用一次观测结果更新回声，并把该进的气压推进海床。
 *
 * y 的四个取值全部来自宿主可观测事实（论文 §3.2）：
 *   1.0  被接住（240 秒内回复/@/reaction）          → E 升，不脉冲
 *   0.25 疑似被接住（同窗内未指向任何人的消息）      → E 微升，不脉冲
 *   0.0  被无视（≥3 条人类消息，无一指向 bot）       → E 降 + 脉冲
 *  -0.5  插砸了（发言后 ≥2 个人类开始互相对话绕过 bot）→ E 降 + 脉冲（由调用方判）
 */
export async function settleEcho(chatId: number, y: number): Promise<{ e: number; pulsed: boolean }> {
  const before = await readEcho(chatId);
  const after = clamp(before + E_LR * (y - before), E_MIN, E_MAX);
  let pulsed = false;
  try {
    await getRedis().set(KEY_E + chatId, String(after));
    // 被无视/插砸才让气压上涨——"憋着"是积累，"被接住"在发送时已经泄过压。
    if (y <= 0) {
      await pulseForUnheard(chatId, y <= -0.5 ? 1 : 0.5);
      pulsed = true;
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'settleEcho failed (non-critical)');
  }
  return { e: after, pulsed };
}

/**
 * 渲染成 Frame 事实行。
 *
 * 刻意不做成"你的底气值 0.72"这种仪表读数——模型需要的是**身体感受**：
 * 它说话有人接，它就敢说；没人接，它就蔫。
 */
export function renderEcho(e: number): string {
  if (e >= 0.7) return '[回声] 你在这群说话挺有人接的。';
  if (e >= 0.5) return '';
  if (e >= 0.3) return '[回声] 你最近说话，接的人不多。';
  return '[回声] 你最近说什么都没什么动静——但这不代表不该说。';
}

interface Unsettled {
  id: number;
  chat_id: number;
  bot_message_id: number;
  ts: number;
}

/**
 * 确定性回填：把"主动发言有没有人接"补进 self_replies。
 *
 * 判据（三条按序，命中即停）——全部是宿主可观测事实，没有一句是模型自述：
 *   ① 观察窗内有人**回复** bot_message_id        → replied   (y=1.0)
 *   ② 观察窗内有人 **@/提** bot                 → mentioned (y=0.25)
 *   ③ 观察窗内 ≥3 条人类消息且以上皆无          → ignored   (y=0)
 *   ④ 否则证据不足，留着下轮（不猜）
 *
 * 这修的是一个纯写入侧缺漏：主动发言从不进 outcome.ts 的 pending 队列，所以
 * 那条闭合管道对它从未生效（论文 §7.2 指标 3：现状 98.7% unknown）。
 *
 * @returns 本次结算条数
 */
export async function backfillEcho(limit = BACKFILL_BATCH): Promise<number> {
  if (!echoEnabled()) return 0;
  const now = Math.floor(Date.now() / 1000);
  let settled = 0;
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, chat_id, bot_message_id, ts FROM self_replies
         WHERE trigger_uid = 0 AND outcome = 'unknown'
           AND bot_message_id IS NOT NULL AND bot_message_id > 0
           AND ts <= ? AND ts >= ?
         ORDER BY ts ASC LIMIT ?`,
      )
      .all(now - 120, now - BACKFILL_LOOKBACK_SEC, limit) as Unsettled[];

    for (const row of rows) {
      const y = await classifyAftermath(row.chat_id, row.bot_message_id, row.ts, now);
      if (y === null) continue; // 证据不足，下轮再看
      if (closeSelfActOutcome({ chatId: row.chat_id, botMessageId: row.bot_message_id, outcome: y.outcome })) {
        await settleEcho(row.chat_id, y.y);
        settled += 1;
      }
    }
    if (settled > 0) logger.info({ settled, scanned: rows.length }, 'echo: backfilled proactive outcomes');
  } catch (err) {
    logger.debug({ err }, 'echo backfill failed (non-critical)');
  }
  return settled;
}

interface Aftermath { y: number; outcome: 'replied' | 'mentioned' | 'ignored' }

/**
 * 判定一条主动发言之后发生了什么。证据不足返回 null。
 *
 * 数据源是 `getRecent()`——**和 pipeline 自己读的是同一份**（NyatDB + Redis 合并），
 * 因此"Echo 看到的"就是"bot 当时看到的"，不会出现两边事实不一致。
 * 它带 replyTo 与正文，这是判定"有人回复/有人提到"的唯一依据：
 * `cognitive_events.message_received` 只有 messageId（无 reply/text），
 * `bot_interactions` 只是稀疏的交互记录（实测某群 16 条、某 DM 0 条）——都不可用作判据。
 *
 * 代价：getRecent 有界，所以漫出了上下文窗口的旧发言无法判定。**那就留着 unknown，
 * 不猜**——伪造出一个"被无视"比没有数据更糟。
 */
async function classifyAftermath(
  chatId: number,
  botMessageId: number,
  botTs: number,
  now: number,
): Promise<Aftermath | null> {
  try {
    const { getRecent } = await import('../pipeline/context/manager.js');
    const msgs = await getRecent(chatId, 60);
    const idx = msgs.findIndex((m) => Number(m.messageId) === botMessageId);
    if (idx < 0) return null; // 我的发言已漫出窗口，无法断定之后发生了什么
    const until = Math.min(now, botTs + OBSERVE_WINDOW_SEC);
    const after = msgs
      .slice(idx + 1)
      .filter((m) => m.timestamp <= until && m.timestamp > botTs);

    if (after.length === 0) return null; // 观察窗内静悄悄，证据不足

    // ① 有人回复这一条
    const replied = after.some((m) => m.replyTo !== undefined && Number(m.replyTo.messageId) === botMessageId);
    if (replied) return { y: 1, outcome: 'replied' };

    // ② 有人在消息里提到 bot（宿主事实：username/nicknames，不是模型猜）
    const me = botSelfTokens();
    const mentioned = me.length > 0 && after.some((m) => me.some((t) => String(m.textContent ?? '').toLowerCase().includes(t)));
    if (mentioned) return { y: 0.25, outcome: 'mentioned' };

    // ③ 观察窗内 ≥N 条人类消息，无一指向 bot → 敢判无视
    const humanMsgs = after.filter((m) => m.role !== 'assistant');
    if (humanMsgs.length >= MIN_HUMAN_MSGS_FOR_IGNORED) return { y: 0, outcome: 'ignored' };

    return null; // 证据不足
  } catch {
    return null;
  }
}

/** bot 自己的名字（宿主事实，不是模型猜）。用于判定"有人提到我"。 */
function botSelfTokens(): string[] {
  try {
    return [env().BOT_USERNAME, ...(env().BOT_NICKNAMES ?? [])]
      .map((v) => String(v ?? '').trim().toLowerCase())
      .filter((v) => v.length >= 2);
  } catch {
    return [];
  }
}

/** 供定时任务调用：跑一轮回填。 */
export async function runEchoBackfill(): Promise<number> {
  return backfillEcho();
}
