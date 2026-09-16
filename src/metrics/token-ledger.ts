// ────────────────────────────────────────
// 持久化 LLM token 记账(重启不清零)
// ────────────────────────────────────────
// Prometheus 计数器是内存态,重启即清零 → 无"累计/日报"。这里订阅同一条
// llmEvents 总线,把 token 按 天×provider(label)×usage×kind 攒在内存里,
// 定时批量 flush 进 SQLite(不在每次 LLM 调用后同步写库)。回答"StepFun 每天
// 吃了多少 / 各用途占比 / 缓存命中"。

import { getDb } from '../db/sqlite.js';
import { llmEvents, type LlmResultEvent } from '../ai/events.js';
import { logger } from '../shared/logger.js';

const FLUSH_INTERVAL_MS = 60_000;
const SEP = '\x01';

// pending 增量:key = date|label|usage|kind → 未 flush 的 token 增量。
const _pending = new Map<string, number>();
let _timer: NodeJS.Timeout | undefined;
let _inited = false;

/** UTC 'YYYY-MM-DD'(与日志时间轴一致)。 */
function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function bump(date: string, label: string, usage: string, kind: string, n: number): void {
  if (!n || n <= 0) return;
  const k = `${date}${SEP}${label}${SEP}${usage}${SEP}${kind}`;
  _pending.set(k, (_pending.get(k) ?? 0) + n);
}

/** 把内存增量批量 UPSERT 进 SQLite(一个事务),清空 pending。 */
export function flushTokenLedger(): void {
  if (_pending.size === 0) return;
  const rows = [..._pending.entries()];
  _pending.clear();
  try {
    const stmt = getDb().prepare(
      `INSERT INTO llm_token_daily (date, label, usage, kind, tokens)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date, label, usage, kind) DO UPDATE SET tokens = tokens + excluded.tokens`,
    );
    const tx = getDb().transaction((entries: Array<[string, number]>) => {
      for (const [k, n] of entries) {
        const [date, label, usage, kind] = k.split(SEP);
        stmt.run(date, label, usage, kind, n);
      }
    });
    tx(rows);
  } catch (err) {
    // flush 失败:把增量放回 pending,下次重试(不丢账)。
    for (const [k, n] of rows) _pending.set(k, (_pending.get(k) ?? 0) + n);
    logger.debug({ err }, 'token-ledger flush failed (will retry)');
  }
}

/** 启动时订阅事件 + 起定时 flush。幂等。 */
export function initTokenLedger(): void {
  if (_inited) return;
  _inited = true;
  llmEvents.on('result', (e: LlmResultEvent) => {
    if (e.outcome !== 'ok') return;
    const date = utcDate();
    bump(date, e.label, e.usage, 'prompt', e.promptTokens);
    bump(date, e.label, e.usage, 'completion', e.completionTokens);
    if (e.cachedTokens > 0) bump(date, e.label, e.usage, 'cached', e.cachedTokens);
  });
  _timer = setInterval(flushTokenLedger, FLUSH_INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}

/** 关机时停定时器 + 最后 flush 一次(别丢最后一分钟的账)。 */
export function stopTokenLedger(): void {
  if (_timer) { clearInterval(_timer); _timer = undefined; }
  flushTokenLedger();
}

export interface TokenReportRow {
  label: string;
  prompt: number;
  completion: number;
  cached: number;
  total: number;
}

/**
 * 某日(默认今天 UTC)按 provider 汇总的 token 报表。先 flush 保证含最新增量。
 */
export function getTokenReport(date?: string): { date: string; byLabel: TokenReportRow[]; total: TokenReportRow } {
  flushTokenLedger();
  const d = date ?? utcDate();
  const byLabel = new Map<string, TokenReportRow>();
  const total: TokenReportRow = { label: 'TOTAL', prompt: 0, completion: 0, cached: 0, total: 0 };
  try {
    const rows = getDb().prepare(
      `SELECT label, kind, SUM(tokens) AS t FROM llm_token_daily WHERE date = ? GROUP BY label, kind`,
    ).all(d) as Array<{ label: string; kind: string; t: number }>;
    for (const r of rows) {
      const row = byLabel.get(r.label) ?? { label: r.label, prompt: 0, completion: 0, cached: 0, total: 0 };
      if (r.kind === 'prompt') row.prompt += r.t;
      else if (r.kind === 'completion') row.completion += r.t;
      else if (r.kind === 'cached') row.cached += r.t;
      byLabel.set(r.label, row);
    }
    for (const row of byLabel.values()) {
      row.total = row.prompt + row.completion; // cached 是 prompt 子集,不另加
      total.prompt += row.prompt; total.completion += row.completion;
      total.cached += row.cached; total.total += row.total;
    }
  } catch (err) {
    logger.debug({ err, date: d }, 'getTokenReport query failed');
  }
  return {
    date: d,
    byLabel: [...byLabel.values()].sort((a, b) => b.total - a.total),
    total,
  };
}
