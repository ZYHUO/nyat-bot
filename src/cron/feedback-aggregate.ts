// ────────────────────────────────────────
// Feedback Aggregate — AGI Level 4 P3-C
//
// Hourly cron: 聚合近期 feedback_events → 写入 self_model_notes
// 如果 sentiment 均值明显偏负，生成一条可操作的自我认知。
//
// 2026-09-21：补上 `reply_outcomes` 这一路。原来只读 feedback_events，而那张表
// **一共 4 行**（近 7 天 2 行且都是正的）——自我认知的唯一活水输入是干的，
// self_model_notes 最后一条停在 09-11，之后十天什么都没长出来。
// 真正有量的是 reply_outcomes（12,752 行，带 signal）。见 replyOutcomeStats 的注释。
// ────────────────────────────────────────

import { getDb } from '../db/sqlite.js';
import { saveSelfNotes } from '../tracking/self-model.js';
import { logger } from '../shared/logger.js';

const WINDOW_SEC = 3 * 86400; // 看最近 3 天
const EXTREME_NEGATIVE = -0.35;
const NEGATIVE_THRESHOLD = -0.15;

/** 全局平均 sentiment（最近 windowSec 秒）。 */
function globalSentiment(windowSec: number): number {
  try {
    const since = Math.floor(Date.now() / 1000) - windowSec;
    const r = getDb()
      .prepare(
        `SELECT AVG(sentiment) AS avg FROM feedback_events WHERE created_at >= ?`,
      )
      .get(since) as { avg: number | null };
    return r.avg ?? 0;
  } catch {
    return 0;
  }
}

interface OutcomeStats {
  total: number;
  ignored: number;
  replied: number;
  mentioned: number;
  pos: number;
  neg: number;
}

/**
 * 近窗回复结果聚合。
 *
 * 为什么加这条：`feedback_events` 一共只有 4 行，`reply_outcomes` 有 12,752 行。
 * 后者不是"情绪"，是**我说的话到底有没有人接**——对一只群聊 bot 来说这比
 * sentiment 更接近身份认知。
 *
 * 实测（近 3 天 1208 条）：09-20 一天 738 条 `ignored_5_msgs`（"我连发 5 条没人理"）
 * 对 85 条 `user_replied`。过度发言的直接代价在这张表里写得清清楚楚，而自我认知
 * 从来没读过它。
 */
function replyOutcomeStats(windowSec: number): OutcomeStats {
  const empty: OutcomeStats = { total: 0, ignored: 0, replied: 0, mentioned: 0, pos: 0, neg: 0 };
  try {
    const since = Math.floor(Date.now() / 1000) - windowSec;
    const r = getDb()
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN signal LIKE 'ignored%' THEN 1 ELSE 0 END) AS ignored,
           SUM(CASE WHEN signal = 'user_replied' THEN 1 ELSE 0 END) AS replied,
           SUM(CASE WHEN signal = 'user_mentioned_bot' THEN 1 ELSE 0 END) AS mentioned,
           SUM(CASE WHEN signal = 'explicit_positive' THEN 1 ELSE 0 END) AS pos,
           SUM(CASE WHEN signal = 'explicit_negative' THEN 1 ELSE 0 END) AS neg
         FROM reply_outcomes WHERE ts >= ?`,
      )
      .get(since) as Record<string, number | null> | undefined;
    if (!r) return empty;
    return {
      total: Number(r.total ?? 0),
      ignored: Number(r.ignored ?? 0),
      replied: Number(r.replied ?? 0),
      mentioned: Number(r.mentioned ?? 0),
      pos: Number(r.pos ?? 0),
      neg: Number(r.neg ?? 0),
    };
  } catch {
    return empty;
  }
}

/**
 * 同一条认知在多久内不重复写（秒）。
 *
 * 为什么必须去重：saveSelfNotes 是裸 INSERT，没有唯一约束。原实现的两条文案是
 * 写死的字符串，sentiment 一旦持续偏负就会**每小时插一条一模一样的**——而
 * getActiveSelfNotes 取最新 5 条注入 prompt，会把自我认知整段变成复读。
 */
const DEDUP_WINDOW_SEC = 6 * 3600;

function noteWrittenRecently(prefix: string): boolean {
  try {
    const since = Math.floor(Date.now() / 1000) - DEDUP_WINDOW_SEC;
    const r = getDb()
      .prepare(
        `SELECT 1 AS hit FROM self_model_notes
         WHERE note LIKE ? AND created_at >= ? LIMIT 1`,
      )
      .get(`${prefix}%`, since) as { hit: number } | undefined;
    return !!r;
  } catch {
    return false;
  }
}

export async function runFeedbackAggregate(): Promise<void> {
  try {
    const avg = globalSentiment(WINDOW_SEC);

    const notes: { note: string; evidence?: string }[] = [];

    if (avg && avg !== 0) {
      if (avg < EXTREME_NEGATIVE) {
        notes.push({
          note: '近期用户负面反馈偏多，请反思回复是否过于强势、敷衍或冒犯。少点卖萌，多倾听。',
          evidence: `全局 sentiment=${avg.toFixed(2)}（窗口=${WINDOW_SEC}s）`,
        });
      } else if (avg < NEGATIVE_THRESHOLD) {
        notes.push({
          note: '用户回复情绪略偏负，试试更简短、更少表情，语气更接地气。',
          evidence: `全局 sentiment=${avg.toFixed(2)}`,
        });
      }
    }

    // ── 回复结果自画像（2026-09-21 新增）────────────────────────────────
    // 只报实测事实，不写"你应该少说话"这种指令——下判断是模型的活，宿主只测量。
    const s = replyOutcomeStats(WINDOW_SEC);
    const MIN_SAMPLE = 20; // 样本太少不做判断，宁可不写
    if (s.total >= MIN_SAMPLE) {
      const ignoredPct = Math.round((s.ignored / s.total) * 100);
      const engaged = s.replied + s.mentioned;
      const engagedPct = Math.round((engaged / s.total) * 100);
      if (ignoredPct >= 50 && !noteWrittenRecently('我说的话大部分没人接')) {
        notes.push({
          note:
            `我说的话大部分没人接：近 3 天 ${s.total} 条回复里 ${s.ignored} 条（${ignoredPct}%）` +
            `发出去之后群里没人接，只有 ${engaged} 条（${engagedPct}%）有人回或叫我。` +
            '这不是嗓门不够大，是说太多了——先少说，等真有人叫我或者真有值得说的再说。',
          evidence:
            `reply_outcomes 近 ${WINDOW_SEC}s：total=${s.total} ignored=${s.ignored} ` +
            `replied=${s.replied} mentioned=${s.mentioned} pos=${s.pos} neg=${s.neg}`,
        });
      } else if (engagedPct >= 20 && s.total >= 50 && !noteWrittenRecently('我说的话有人接')) {
        notes.push({
          note:
            `我说的话有人接：近 3 天 ${s.total} 条回复里 ${engaged} 条（${engagedPct}%）` +
            '有人回或者叫我。这个节奏是对的，保持。',
          evidence:
            `reply_outcomes 近 ${WINDOW_SEC}s：total=${s.total} ignored=${s.ignored} ` +
            `replied=${s.replied} mentioned=${s.mentioned}`,
        });
      }
    }

    if (notes.length > 0) saveSelfNotes(notes);
  } catch (err) {
    // 非关键路径，但别再完全静默——这个 cron 曾经"看着在跑、实际一行没写"，
    // 而唯一的线索就是它自己从不打日志。
    logger.debug({ err }, 'feedback aggregate failed');
  }
}
