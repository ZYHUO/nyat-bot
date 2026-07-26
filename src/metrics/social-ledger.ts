// ────────────────────────────────────────
// 社交决策记账 — G8 A/B 的对照基线(重启不清零)
// ────────────────────────────────────────
// 与 token-ledger 同构:内存攒增量 → 定时批量 flush 进 SQLite。
// Prometheus counter 是内存态、重启归零,而基线要连续跑一周。
//
// 记账点全部是"事后陈述",不参与任何决策 —— 出错一律吞掉,telemetry 永不影响主链路。

import { getDb } from '../db/sqlite.js';
import { llmEvents, type LlmResultEvent } from '../ai/events.js';
import { incrCounter } from './registry.js';
import { logger } from '../shared/logger.js';

const FLUSH_INTERVAL_MS = 60_000;
const SEP = '\x01';

export const SOCIAL_METRICS = [
  'msg_seen',
  'decision_reply',
  'decision_wait',
  'decision_pass',
  'reply_sent',
  'interrupt',
  'llm_calls',
  'e2e_latency_ms_sum',
  'e2e_latency_count',
] as const;
export type SocialMetric = (typeof SOCIAL_METRICS)[number];

const _pending = new Map<string, number>();
let _timer: NodeJS.Timeout | undefined;
let _inited = false;

/** UTC 'YYYY-MM-DD' —— 与 llm_token_daily 同口径,两张表才能对齐着看。 */
function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function bump(chatId: number, metric: SocialMetric, n: number): void {
  if (!n || n <= 0 || !Number.isFinite(chatId)) return;
  const k = `${utcDate()}${SEP}${chatId}${SEP}${metric}`;
  _pending.set(k, (_pending.get(k) ?? 0) + n);
}

// ── 记账入口(全部 guarded,绝不抛)────────────────────────

function guard(fn: () => void): void {
  try { fn(); } catch { /* telemetry never breaks the pipeline */ }
}

/** 一条消息进入决策路径(回复/消息比的分母)。 */
export function recordMessageSeen(chatId: number): void {
  guard(() => {
    bump(chatId, 'msg_seen', 1);
    incrCounter('social_messages_seen_total', { chat: chatId });
  });
}

/** 心流决策出口。act 是 reply / wait / pass。 */
export function recordDecision(chatId: number, act: 'reply' | 'wait' | 'pass'): void {
  guard(() => {
    const metric = `decision_${act}` as SocialMetric;
    bump(chatId, metric, 1);
    incrCounter('social_decision_total', { chat: chatId, act });
  });
}

/**
 * 一条回复真正投递出去。latencyMs 是端到端(收到消息 → 发出回复),
 * 传 undefined 表示这条没有可靠的起点时间戳(例如主动发言),只计数不计延迟。
 */
export function recordReplySent(chatId: number, latencyMs?: number): void {
  guard(() => {
    bump(chatId, 'reply_sent', 1);
    incrCounter('social_replies_sent_total', { chat: chatId });
    if (latencyMs !== undefined && latencyMs >= 0 && Number.isFinite(latencyMs)) {
      bump(chatId, 'e2e_latency_ms_sum', Math.round(latencyMs));
      bump(chatId, 'e2e_latency_count', 1);
      incrCounter('social_e2e_latency_ms_sum', { chat: chatId }, Math.round(latencyMs));
      incrCounter('social_e2e_latency_count', { chat: chatId });
    }
  });
}

/** 回合被新消息打断。 */
export function recordInterrupt(chatId: number): void {
  guard(() => {
    bump(chatId, 'interrupt', 1);
    incrCounter('social_interrupts_total', { chat: chatId });
  });
}

// ── flush ───────────────────────────────────────────────

/** 把内存增量批量 UPSERT 进 SQLite(一个事务),清空 pending。 */
export function flushSocialLedger(): void {
  if (_pending.size === 0) return;
  const rows = [..._pending.entries()];
  _pending.clear();
  try {
    const stmt = getDb().prepare(
      `INSERT INTO social_daily (date, chat_id, metric, value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(date, chat_id, metric) DO UPDATE SET value = value + excluded.value`,
    );
    const tx = getDb().transaction((entries: Array<[string, number]>) => {
      for (const [k, n] of entries) {
        const [date, chatId, metric] = k.split(SEP);
        stmt.run(date, Number(chatId), metric, n);
      }
    });
    tx(rows);
  } catch (err) {
    // flush 失败:增量放回 pending,下次重试(不丢账)。
    for (const [k, n] of rows) _pending.set(k, (_pending.get(k) ?? 0) + n);
    logger.debug({ err }, 'social-ledger flush failed (will retry)');
  }
}

/** 启动:订阅 LLM 事件 + 起定时 flush。幂等。 */
export function initSocialLedger(): void {
  if (_inited) return;
  _inited = true;
  // LLM 调用归属:emitLlmResult 现在带可选 chatId。没有 chatId 的调用(cron、
  // 后台任务、未接线的路径)不计入 —— 宁可少算,也不要把别处的开销摊到某个群头上。
  llmEvents.on('result', (e: LlmResultEvent) => {
    if (e.chatId === undefined) return;
    guard(() => bump(e.chatId!, 'llm_calls', 1));
  });
  _timer = setInterval(flushSocialLedger, FLUSH_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}

/** 关机:停定时器 + 最后 flush 一次。 */
export function stopSocialLedger(): void {
  if (_timer) { clearInterval(_timer); _timer = undefined; }
  flushSocialLedger();
}

// ── 报表 ────────────────────────────────────────────────

export interface SocialReportRow {
  chatId: number;
  msgSeen: number;
  replySent: number;
  interrupts: number;
  llmCalls: number;
  /** 每回复 LLM 调用数 —— G8 的核心成本指标(它主张 1 次代替 2-3 次)。 */
  llmCallsPerReply: number | null;
  /** 端到端延迟均值(ms)。 */
  e2eLatencyMs: number | null;
  /** 打断率 = interrupt / reply_sent。 */
  interruptRate: number | null;
  /** 回复/消息比 —— bot 的"话痨程度"。 */
  replyRate: number | null;
  decisions: { reply: number; wait: number; pass: number };
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

/**
 * 读区间内的基线报表(含端点)。日期是 UTC 'YYYY-MM-DD'。
 * 按群返回,因为 G8 的 A/B 就是灰度群与对照群之间比。
 */
export function getSocialReport(fromDate: string, toDate: string): SocialReportRow[] {
  const byChat = new Map<number, Map<string, number>>();
  try {
    const rows = getDb().prepare(
      'SELECT chat_id, metric, SUM(value) AS v FROM social_daily WHERE date >= ? AND date <= ? GROUP BY chat_id, metric',
    ).all(fromDate, toDate) as Array<{ chat_id: number; metric: string; v: number }>;
    for (const r of rows) {
      if (!byChat.has(r.chat_id)) byChat.set(r.chat_id, new Map());
      byChat.get(r.chat_id)!.set(r.metric, r.v);
    }
  } catch (err) {
    logger.debug({ err }, 'getSocialReport failed');
    return [];
  }

  const out: SocialReportRow[] = [];
  for (const [chatId, m] of byChat) {
    const g = (k: SocialMetric): number => m.get(k) ?? 0;
    const replySent = g('reply_sent');
    out.push({
      chatId,
      msgSeen: g('msg_seen'),
      replySent,
      interrupts: g('interrupt'),
      llmCalls: g('llm_calls'),
      llmCallsPerReply: ratio(g('llm_calls'), replySent),
      e2eLatencyMs: ratio(g('e2e_latency_ms_sum'), g('e2e_latency_count')),
      interruptRate: ratio(g('interrupt'), replySent),
      replyRate: ratio(replySent, g('msg_seen')),
      decisions: { reply: g('decision_reply'), wait: g('decision_wait'), pass: g('decision_pass') },
    });
  }
  return out.sort((a, b) => b.msgSeen - a.msgSeen);
}
