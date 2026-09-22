// ────────────────────────────────────────
// Stage F: Self-narrative — bot remembers what it said
// ────────────────────────────────────────
//
// 两个互补的读法，同一个表：
//
// 1. 对某个人说过什么（原用途）→ 生成下一条前注入，避免前后矛盾。
// 2. 我最近在这个群的整体表现（2026-09 新增）→ 让模型看见"我说了 4 次，
//    2 次有人接、1 次没人理、1 次被纠正"。它自己判断要不要收着点。
//
// 第 2 条针对一个真实事故（src/pipeline/heart/heart.ts:66-76）：
//   "bot 说一句 → 后续消息命中跟进规则 → 自动回 → 永远'刚说过话'
//    → 69 次回复里只有 12 次经过心流"
// 根因是模型看不见自己刚做过什么。给它事实，它自己会收敛——不需要新规则。
//
// 注意与 outcome.ts 的分工：那边产出【抽象规则】（3-5 条，日更，门槛 15 条）；
// 这里产出【具体行为史】（即时，带结果）。两者互补，谁都不替代谁。
//
// 数据：self_replies(id, chat_id, trigger_uid, trigger_msg_id, reply_text, ts,
//                    bot_message_id, outcome, outcome_at)
//   - 每发一条 reply 就 INSERT 一条
//   - 查询：(chat_id, uid) 过滤 + ts 倒序 limit N，且 ts 在 windowDays 内
//   - cleanup: pruneOldSelfReplies(60) 删 60 天以上的
//
// 默认 SELF_HISTORY_ENABLED=false 时所有公开函数 no-op，保证零开销。

import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getRedis } from '../db/redis.js';

export interface SelfReply {
  ts: number;
  text: string;
}

/** How a sent message landed, as observed by the host (never self-reported). */
export type ActOutcome =
  | 'ignored'    // nobody engaged within the observation window
  | 'replied'    // someone replied to it
  | 'reacted'    // someone reacted / explicitly approved
  | 'mentioned'  // someone mentioned the bot afterwards
  | 'corrected'  // a human pushed back on it
  | 'unknown';   // window not closed yet

/** A sent message plus what happened to it. */
export interface SelfAct {
  ts: number;
  botMessageId: number;
  text: string;
  outcome: ActOutcome;
}

/** Bounded view of the bot's own recent behaviour in one chat. */
export interface SelfActSummary {
  chatId: number;
  windowSec: number;
  total: number;
  byOutcome: Record<ActOutcome, number>;
  recent: SelfAct[];
  sinceLastSpokeSec?: number;
  /**
   * How much of the window's conversation was the bot's.
   *
   * A raw count ("you said 14 things") gives no sense of scale — 14 is a lot in
   * a quiet group and nothing in a busy one. A person's sense of talking too
   * much is relative: "am I dominating this room?" This is that ratio, computed
   * from data already stored, so the model can judge for itself instead of
   * having a host-side gate stop it after the fact.
   */
  shareOfConversation?: number;
  /**
   * 这个群的**长期基线占比**（默认回看 7 天，Redis 缓存 6 小时）。
   *
   * round 16（新 goal，用户："bot 还是太爱说话了"）。加它的原因是一次实测：
   * 白天按群拆分，回复率从 13.8%（最活跃的群）到 70.8%（小群）**差 5 倍**，
   * 而全量一个 17% 的均数把这件事完全盖住了。
   *
   * `shareOfConversation` 是**这一波**的占比（per-chat，30 分钟窗口），
   * 它是相对值但没有参照——模型看到"这一波 42%"不知道在该不该收。
   * 心流 prompt 里的门槛原本写死"≥30% 默认不接"，那是全局一条线：
   * 平时只占 10% 的群和平时占 60% 的群读同一句，等于没按群区分。
   *
   * 有了基线就能说人话："这一波你占了 42%，**这个群你平时约 18%**"
   * ——同一个数字在不同群里含义完全不同，而 bot 自己知道每个群的常态。
   */
  baselineShare?: number;
  /** baselineShare 的回看天数（未命中缓存时现场算，写进结果供渲染说明）。 */
  baselineDays?: number;
  /**
   * 这个群你的**绝对节奏**：条/小时（默认回看 7 天 / 清醒时段）。
   *
   * round 17（新 goal，用户："bot 还是太爱说话了"）。加它是因为一次实测翻转：
   * 按群看，占比和"吵不吵"根本是两回事——
   *
   *   chat                 占比     条/小时
   *   -1003821093564      12.1%     14.8     ← 占比最低，节奏最高
   *   -1003543275052      12.2%     13.0     ← 占比同样低，每 4.6 分钟一句
   *   -1002450361141      72.6%      2.9     ← 占比最高，其实最安静
   *
   * 我调了 17 轮占比门槛（≥30% 默认不接、比基线高 1.5 倍才提示），
   * 而那两个最吵的群占比只有 12%——**判据在它们身上永远不触发**。
   * 一个群里的人感知的是"它每隔几分钟就冒一句"，不是"它占了多少字数"。
   *
   * 注意和 baselineShare 的分工：占比答"我是不是在自言自语"，
   * 节奏答"我是不是太吵"。两个都要给，缺一个就有一个盲区。
   */
  cadencePerHour?: number;
}

/** Preview length; long previews push the rendered block past its budget. */
const ACT_PREVIEW_CHARS = 48;
/** Cap on records rendered into the prompt. */
const ACT_MAX_RECENT = 6;

/** Map an existing reply-outcome signal onto an act outcome. */
export function actOutcomeFromSignal(signal: string): ActOutcome {
  switch (signal) {
    case 'user_replied':
      return 'replied';
    case 'user_mentioned_bot':
      return 'mentioned';
    case 'explicit_positive':
      return 'reacted';
    case 'explicit_negative':
    case 'repair_loop':
      return 'corrected';
    case 'ignored_5_msgs':
      return 'ignored';
    // 时间感知的 ignored：等太久（≥OUTCOME_MAX_WAIT_SEC）且期间确有人说过话。
    // 形如 ignored_660s_no_reply；前缀匹配而不是逐个秒数枚举。
    default:
      return signal.startsWith('ignored_') ? 'ignored' : 'unknown';
  }
}

/** Strip newlines/control chars so one record cannot forge extra prompt lines. */
function inline(value: string, max: number): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, max);
}

/**
 * Attach an observed outcome to the specific message the bot sent.
 *
 * Matching on `bot_message_id` keeps the pairing exact; picking "most recent
 * unknown" would mis-attribute when several bubbles went out in one turn.
 * Reuses the signal outcome.ts already computed rather than observing twice.
 */
export function closeSelfActOutcome(input: {
  chatId: number;
  botMessageId: number;
  outcome: ActOutcome;
  at?: number;
}): boolean {
  if (!env().SELF_HISTORY_ENABLED) return false;
  if (input.outcome === 'unknown') return false;
  if (!Number.isSafeInteger(input.chatId) || input.chatId === 0) return false;
  if (!Number.isSafeInteger(input.botMessageId) || input.botMessageId <= 0) return false;
  const at = Number.isSafeInteger(input.at) && (input.at ?? 0) > 0
    ? Number(input.at)
    : Math.floor(Date.now() / 1000);
  try {
    const result = getDb().prepare(
      `UPDATE self_replies SET outcome = ?, outcome_at = ?
       WHERE chat_id = ? AND bot_message_id = ? AND outcome = 'unknown'`,
    ).run(input.outcome, at, input.chatId, input.botMessageId) as { changes?: number };
    if (result.changes !== 1) return false;
    // Mirror the observation into the event ledger as `own_action_result`, so the
    // cognitive clock (agent/cognitive-clock.ts) can render "what I just did" from
    // the append-only stream. Both paths (pipeline and Meta) reach this function,
    // so wiring here covers them without touching either call site.
    // Dynamic import keeps this module free of a hard dependency on the ledger.
    if (env().COGNITIVE_CLOCK_ENABLED) {
      void import('../agent/cognitive-clock.js')
        .then(({ recordOwnActionResult }) => {
          recordOwnActionResult({
            scope: { visibility: 'chat', chatId: input.chatId },
            botMessageId: input.botMessageId,
            outcome: input.outcome,
            occurredAt: at,
          });
        })
        .catch(() => { /* clock is an aid; the durable row above is the source of truth */ });
    }
    return true;
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'closeSelfActOutcome failed (non-critical)');
    return false;
  }
}

/**
 * Read the bot's own recent behaviour in one chat, with outcomes.
 * Returns null when disabled or there is nothing to show.
 */
export function getSelfActSummary(
  chatId: number,
  windowSec: number,
  baselineShare?: number,
  cadencePerHour?: number,
): SelfActSummary | null {
  if (!env().SELF_HISTORY_ENABLED) return null;
  if (!Number.isSafeInteger(chatId) || chatId === 0) return null;
  const window = Math.max(60, Math.trunc(windowSec));
  const since = Math.floor(Date.now() / 1000) - window;
  try {
    const rows = getDb().prepare(
      `SELECT bot_message_id, ts, reply_text, outcome FROM self_replies
       WHERE chat_id = ? AND ts >= ?
       ORDER BY ts DESC, id DESC LIMIT 50`,
    ).all(chatId, since) as Array<{
      bot_message_id: number | null;
      ts: number;
      reply_text: string;
      outcome: string;
    }>;
    if (rows.length === 0) return null;

    const byOutcome: Record<ActOutcome, number> = {
      ignored: 0, replied: 0, reacted: 0, mentioned: 0, corrected: 0, unknown: 0,
    };
    for (const row of rows) {
      const key = (row.outcome as ActOutcome) in byOutcome
        ? (row.outcome as ActOutcome)
        : 'unknown';
      byOutcome[key] += 1;
    }
    const newest = rows[0]!;
    // How busy was the room? Same window, human messages only.
    let shareOfConversation: number | undefined;
    try {
      const human = getDb().prepare(
        `SELECT COUNT(*) AS c FROM cognitive_events
         WHERE type = 'message_received' AND chat_id = ? AND occurred_at >= ?`,
      ).get(chatId, since) as { c: number } | undefined;
      const humanCount = human?.c ?? 0;
      if (humanCount > 0) {
        shareOfConversation = Math.min(1, rows.length / humanCount);
      }
    } catch { /* optional context; never block the summary */ }
    return {
      chatId,
      windowSec: window,
      total: rows.length,
      // round 16：调用方传基线就带上；没传就 undefined（渲染时不说相对那句）。
      ...(baselineShare !== undefined ? { baselineShare } : {}),
      ...(cadencePerHour !== undefined ? { cadencePerHour } : {}),
      byOutcome,
      ...(shareOfConversation === undefined ? {} : { shareOfConversation }),
      recent: rows.slice(0, ACT_MAX_RECENT).map((row) => ({
        ts: row.ts,
        botMessageId: row.bot_message_id ?? 0,
        text: row.reply_text,
        outcome: (row.outcome as ActOutcome) in byOutcome
          ? (row.outcome as ActOutcome)
          : 'unknown',
      })),
      sinceLastSpokeSec: Math.max(0, Math.floor(Date.now() / 1000) - newest.ts),
    };
  } catch (err) {
    logger.debug({ err, chatId }, 'getSelfActSummary failed (non-critical)');
    return null;
  }
}

/**
 * Render the summary as a compact fact block.
 *
 * Deliberately factual: it reports what happened and lets the model judge.
 * No thresholds, no "you should speak less", no quota — the host draws no
 * behavioural conclusion, because that decision belongs to the model.
 */


/**
 * 这个群的长期基线占比 = 本喵发言 / 人类发言，回看 `days` 天。
 *
 * Redis 缓存 BASELINE_TTL_SEC（6 小时）：DB 聚合要扫 cognitive_events，
 * 而心流是全系统调用频次最高的路径，不能每条消息都扫一次。
 * 基线本身变化很慢（一个群的作息不会几小时一变），6 小时足够。
 *
 * 任何失败都返回 undefined —— 那是"不知道自己的常态"，渲染时不说这句，
 * 退回到原来的绝对占比。**基线是参照，不是门槛**，缺了不该让心流变哑。
 */
const BASELINE_CACHE_KEY = (chatId: number): string => `xxb:selfhist:baseline:${chatId}`;
const BASELINE_DAYS = 7;
const BASELINE_TTL_SEC = 6 * 3600;

export async function getSelfShareBaseline(
  chatId: number,
  days = BASELINE_DAYS,
): Promise<number | undefined> {
  if (!Number.isSafeInteger(chatId) || chatId >= 0) return undefined;
  const key = BASELINE_CACHE_KEY(chatId);
  try {
    const cached = await getRedis().get(key);
    if (cached !== null) {
      const v = Number.parseFloat(cached);
      if (Number.isFinite(v)) return v;
    }
  } catch { /* cache miss → 现场算 */ }

  try {
    const db = getDb();
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const botRow = db.prepare(
      `SELECT COUNT(*) AS c FROM self_replies WHERE chat_id = ? AND ts >= ?`,
    ).get(chatId, since) as { c: number } | undefined;
    const humanRow = db.prepare(
      `SELECT COUNT(*) AS c FROM cognitive_events
       WHERE type = 'message_received' AND chat_id = ? AND occurred_at >= ?`,
    ).get(chatId, since) as { c: number } | undefined;
    const bot = botRow?.c ?? 0;
    const human = humanRow?.c ?? 0;
    // 样本太少算不出常态（一个新群前 20 条什么都说明不了）
    if (human < 50) return undefined;
    const share = Math.min(1, bot / human);
    void getRedis().set(key, share.toFixed(4), 'EX', BASELINE_TTL_SEC).catch(() => {});
    return share;
  } catch {
    return undefined;
  }
}



/**
 * 这个群的绝对节奏（条/小时）。Redis 缓存 6 小时，判据同 getSelfShareBaseline。
 *
 * 分母用**清醒时段**而不是自然小时：一个 24 小时都有人说话的群，和只在白天
 * 热闹的群，"每小时 X 条"不是一回事。这里按 group_messages 数归一化成
 * "每 1000 条入站你发几条"，再折算成条/小时——等价但不怕群作息差异。
 *
 * 任何失败返回 undefined：节奏是参照，不是门槛，缺了不该让心流变哑。
 */
export async function getSelfCadence(
  chatId: number,
  days = BASELINE_DAYS,
): Promise<number | undefined> {
  if (!Number.isSafeInteger(chatId) || chatId >= 0) return undefined;
  const key = `xxb:selfhist:cadence:${chatId}`;
  try {
    const cached = await getRedis().get(key);
    if (cached !== null) {
      const v = Number.parseFloat(cached);
      if (Number.isFinite(v)) return v;
    }
  } catch { /* miss → 现场算 */ }

  try {
    const db = getDb();
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    const botRow = db.prepare(
      `SELECT COUNT(*) AS c FROM self_replies WHERE chat_id = ? AND ts >= ?`,
    ).get(chatId, since) as { c: number } | undefined;
    const spanRow = db.prepare(
      `SELECT MAX(occurred_at) - MIN(occurred_at) AS span FROM cognitive_events
       WHERE type = 'message_received' AND chat_id = ? AND occurred_at >= ?`,
    ).get(chatId, since) as { span: number | null } | undefined;
    const bot = botRow?.c ?? 0;
    const span = spanRow?.span ?? 0;
    // 至少要有 6 小时的跨度才算得出节奏，否则一天说 10 条会被算成很凶
    if (bot < 10 || span < 6 * 3600) return undefined;
    const perHour = bot / (span / 3600);
    void getRedis().set(key, perHour.toFixed(3), 'EX', BASELINE_TTL_SEC).catch(() => {});
    return perHour;
  } catch {
    return undefined;
  }
}

export function renderSelfActSummary(summary: SelfActSummary | null): string {
  if (!summary || summary.total === 0) return '';
  const label: Record<ActOutcome, string> = {
    ignored: '没人接',
    replied: '有人回',
    reacted: '有人应',
    mentioned: '有人提到你',
    corrected: '被纠正',
    unknown: '还没结果',
  };
  const minutes = Math.max(1, Math.round(summary.windowSec / 60));
  const parts: string[] = [];
  for (const key of ['replied', 'reacted', 'mentioned', 'ignored', 'corrected', 'unknown'] as ActOutcome[]) {
    const n = summary.byOutcome[key];
    if (n > 0) parts.push(`${label[key]} ${n}`);
  }
  const since = summary.sinceLastSpokeSec;
  const sinceText = since === undefined
    ? ''
    : since < 90
      ? '，最近一次就在刚刚'
      : `，最近一次 ${Math.round(since / 60)} 分钟前`;

  // A raw count means nothing without scale. "你说了 14 条" is a lot in a quiet
  // group and nothing in a busy one — what a person actually notices is whether
  // they are dominating the room. Rendered as a felt sense, not a statistic.
  const share = summary.shareOfConversation;
  // round 16：**和这个群自己的常态比**，不是和一条全局线比。
  //
  // 白天实测：回复率 13.8%（1793 条的活跃群）到 70.8%（48 条的小群）。
  // 写死"≥30% 就说多了"的话，前者永远触不到、后者永远触发——两边都学不到东西。
  // 现在给出"这一波 X%，这个群你平时约 Y%"，让"比平时高多少"成为可判断的事实。
  //
  // 阈值：高出基线 1.5 倍才算"这一波偏多"，持平和偏低不提（别无病呻吟）。
  const base = summary.baselineShare;
  const relText = (share !== undefined && base !== undefined && base > 0 && share >= base * 1.5)
    ? `（这个群你平时约 ${Math.round(base * 100)}%）`
    : '';
  const shareText = share === undefined
    ? ''
    : share >= 0.5
      ? `，这一波基本是你一个人在说${relText}`
      : share >= 0.3
        ? `，这一波你说得有点多${relText}`
        : share >= 0.15
          ? `，这一波你插了几句${relText}`
          : '';

  // round 17：节奏单独一行。占比那句话已经够长了，而节奏是另一个维度的事。
  // 超过每小时 5 条就明说"挺密的"——一个真人不会每四分钟说一句而不自觉。
  const cad = summary.cadencePerHour;
  const cadenceLine = cad === undefined
    ? ''
    : `[你的节奏] 这个群你平时每小时说 ${cad.toFixed(1)} 条${
        cad >= 5 ? '（挺密的——群里的人每隔几分钟就看见你一次。真人不会这样。）' : ''
      }`;

  const lines = [
    `[你自己的近况] 最近 ${minutes} 分钟里你在这个群说了 ${summary.total} 次（${parts.join(' · ')}）${sinceText}${shareText}。`,
  ];
  if (cadenceLine) lines.push(cadenceLine);
  // Concrete lines let the model recognise its own repetition instead of only
  // seeing counts.
  const nowSec = Math.floor(Date.now() / 1000);
  for (const act of summary.recent.slice(0, 4)) {
    const ago = Math.max(1, Math.round((nowSec - act.ts) / 60));
    lines.push(`  ${ago}分钟前 你说「${inline(act.text, ACT_PREVIEW_CHARS)}」→ ${label[act.outcome]}`);
  }
  return lines.join('\n');
}

/** Persist a single reply made by the bot. No-op when disabled. */
export function recordSelfReply(
  chatId: number,
  triggerUid: number,
  triggerMsgId: number | null,
  replyText: string,
  botMessageId?: number,
): void {
  if (!env().SELF_HISTORY_ENABLED) return;
  const text = (replyText ?? '').trim();
  if (!text) return;
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO self_replies
         (chat_id, trigger_uid, trigger_msg_id, reply_text, ts, bot_message_id, outcome)
       VALUES (?, ?, ?, ?, ?, ?, 'unknown')`,
    ).run(
      chatId,
      triggerUid,
      triggerMsgId,
      text.slice(0, 500),
      Math.floor(Date.now() / 1000),
      Number.isSafeInteger(botMessageId) && (botMessageId ?? 0) > 0 ? Number(botMessageId) : null,
    );
  } catch (err) {
    logger.debug({ err, chatId, triggerUid }, 'recordSelfReply failed (non-critical)');
  }
}

/**
 * Get up to `limit` recent self replies to a specific user within `withinDays` days.
 * Returns [] when disabled.
 */
export function getRecentSelfReplies(
  chatId: number,
  uid: number,
  limit = 5,
  withinDays = 30,
): SelfReply[] {
  if (!env().SELF_HISTORY_ENABLED) return [];
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - withinDays * 86400;
    const rows = db
      .prepare(
        `SELECT reply_text AS text, ts FROM self_replies
         WHERE chat_id = ? AND trigger_uid = ? AND ts >= ?
         ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(chatId, uid, cutoff, limit) as { text: string; ts: number }[];
    return rows;
  } catch (err) {
    logger.debug({ err, chatId, uid }, 'getRecentSelfReplies failed (non-critical)');
    return [];
  }
}

/**
 * bot 在这个群最近发过的话（不分触发者，用于自我统计）。
 *
 * 为什么不复用 getRecentSelfReplies：那个按 trigger_uid 过滤，语义是"我回过这个人的话"；
 * 而"我最近说话是什么样"要按群取，跟触发者无关。2026-09-19 用在 room-awareness 的
 * 自我统计上（喵尾巴率、平均长度）——把自己的行为数据变成模型能看见的事实，
 * 而不是写死规则去摘它的尾巴。
 */
export function getRecentBotTextsInChat(chatId: number, limit = 12, withinMin = 360): string[] {
  if (!env().SELF_HISTORY_ENABLED) return [];
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - withinMin * 60;
    const rows = db
      .prepare(
        `SELECT reply_text AS text FROM self_replies
         WHERE chat_id = ? AND ts >= ?
         ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(chatId, cutoff, limit) as { text: string }[];
    return rows.map((r) => String(r.text ?? '')).filter(Boolean);
  } catch (err) {
    logger.debug({ err, chatId }, 'getRecentBotTextsInChat failed (non-critical)');
    return [];
  }
}

/**
 * 取某群最近 N 条 bot 自己的发言(不按 uid 过滤)——口头禅自动惩罚闭环的数据源。
 * 返回 [] when disabled.
 */
export function getRecentChatReplies(chatId: number, limit = 60, withinHours = 24): SelfReply[] {
  if (!env().SELF_HISTORY_ENABLED) return [];
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - withinHours * 3600;
    const rows = db
      .prepare(
        `SELECT reply_text AS text, ts FROM self_replies
         WHERE chat_id = ? AND ts >= ?
         ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(chatId, cutoff, limit) as { text: string; ts: number }[];
    return rows;
  } catch (err) {
    logger.debug({ err, chatId }, 'getRecentChatReplies failed (non-critical)');
    return [];
  }
}

/**
 * Format recent self replies as a prompt section. Returns empty string when no entries
 * or feature off.
 */
export function selfHistoryPromptSection(replies: SelfReply[]): string {
  if (!replies || replies.length === 0) return '';
  const lines = replies.map((r) => {
    const dt = new Date(r.ts * 1000);
    const stamp = `${dt.getMonth() + 1}/${dt.getDate()}`;
    const text = r.text.length > 80 ? r.text.slice(0, 80) + '…' : r.text;
    return `- ${stamp}: ${text}`;
  });
  return `【你最近对 ta 说过的话】\n${lines.join('\n')}\n注意保持一致，避免前后矛盾。`;
}

/**
 * Delete self_replies entries older than `olderThanDays` days. Returns count deleted.
 * Safe to call with feature off (just no-op).
 */
export function pruneOldSelfReplies(olderThanDays = 60): number {
  if (!env().SELF_HISTORY_ENABLED) return 0;
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - olderThanDays * 86400;
    const result = db.prepare('DELETE FROM self_replies WHERE ts < ?').run(cutoff);
    const deleted = Number(result.changes ?? 0);
    if (deleted > 0) {
      logger.info({ deleted, olderThanDays }, 'pruneOldSelfReplies completed');
    }
    return deleted;
  } catch (err) {
    logger.warn({ err }, 'pruneOldSelfReplies failed');
    return 0;
  }
}
