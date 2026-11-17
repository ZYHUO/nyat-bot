// ────────────────────────────────────────
// 持久化 LLM token 记账(重启不清零)
// ────────────────────────────────────────
// Prometheus 计数器是内存态,重启即清零 → 无"累计/日报"。这里订阅同一条
// llmEvents 总线,把 token 按 天×provider(label)×usage×kind 攒在内存里,
// 定时批量 flush 进 SQLite(不在每次 LLM 调用后同步写库)。回答"StepFun 每天
// 吃了多少 / 各用途占比 / 缓存命中"。

import { getDb } from '../db/sqlite.js';
import { cacheDimensions, cacheObservation, llmEvents, metricDimension, validTokenCount, type LlmResultEvent } from '../ai/events.js';
import { logger } from '../shared/logger.js';

const FLUSH_INTERVAL_MS = 60_000;
const CACHE_KIND_PREFIX = 'cache_v2:';

// pending 增量:key = date|label|usage|kind → 未 flush 的 token 增量。
const _pending = new Map<string, number>();
let _timer: NodeJS.Timeout | undefined;
let _inited = false;

/** UTC 'YYYY-MM-DD'(与日志时间轴一致)。 */
function utcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function bump(date: string, label: string, usage: string, kind: string, n: number): void {
  if (!validTokenCount(n) || n === 0) return;
  const k = JSON.stringify([date, label, usage, kind]);
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
        const [date, label, usage, kind] = JSON.parse(k) as [string, string, string, string];
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
    const dimensions = cacheDimensions(e);
    bump(date, dimensions.label, dimensions.usage, 'prompt', e.promptTokens);
    bump(date, dimensions.label, dimensions.usage, 'completion', e.completionTokens);
    if (validTokenCount(e.cachedTokens)) bump(date, dimensions.label, dimensions.usage, 'cached', e.cachedTokens);
    // Existing kinds retain their meaning. Versioned kinds contain only bounded
    // configuration dimensions, never prompt text, endpoint URLs or credentials.
    const add = (kind: CacheKind, value: number) => bump(date, dimensions.label, dimensions.usage,
      CACHE_KIND_PREFIX + JSON.stringify([dimensions.model, dimensions.path, kind]), value);
    const observation = cacheObservation(e);
    add('reported_prompt', e.promptTokens);
    add('reported_completion', e.completionTokens);
    if (validTokenCount(e.cachedTokens)) add('reported_cached', e.cachedTokens);
    add(observation.coverage, 1);
    if (observation.input !== undefined) add('observed_input', observation.input);
    if (observation.read !== undefined) {
      add('covered_input', observation.input!);
      add('read', observation.read);
    }
    add(observation.write === undefined ? 'write_unknown' : 'write_known', 1);
    if (observation.write !== undefined) add('write', observation.write);
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
  /** New observations only. Historical rows have no reconstructible request count. */
  observedResults: number;
  knownCacheResults: number;
  unknownInputResults: number;
  unknownCacheResults: number;
  knownWriteResults: number;
  unknownWriteResults: number;
  observedInputTokens: number;
  coveredInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRatio: number | null;
  cacheReportingRate: number | null;
  /** Input tokens outside the known-cache population, including historical rows. */
  uncoveredPromptTokens: number;
  legacyPromptTokens: number;
  historicalCoverage: 'no_data' | 'untracked' | 'partial' | 'tracked';
}

export interface TokenRouteReportRow extends TokenReportRow {
  usage: string;
  model: string;
  path: string;
}

const CACHE_KINDS = ['reported_prompt', 'reported_completion', 'reported_cached', 'known', 'input_unknown',
  'cache_unknown', 'observed_input', 'covered_input', 'read', 'write', 'write_known', 'write_unknown'] as const;
type CacheKind = typeof CACHE_KINDS[number];
const CACHE_PATHS = new Set(['anthropic_json', 'openai_json', 'openai_stream', 'openai_sdk', 'unknown']);

function parseCacheKind(raw: string): { model: string; path: string; kind: CacheKind } | null {
  if (!raw.startsWith(CACHE_KIND_PREFIX) || raw.length > 240) return null;
  try {
    const parts: unknown = JSON.parse(raw.slice(CACHE_KIND_PREFIX.length));
    if (!Array.isArray(parts) || parts.length !== 3) return null;
    const [model, path, kind] = parts as unknown[];
    if (typeof model !== 'string' || metricDimension(model) !== model || typeof path !== 'string'
      || !CACHE_PATHS.has(path) || typeof kind !== 'string' || !CACHE_KINDS.includes(kind as CacheKind)) return null;
    return { model, path, kind: kind as CacheKind };
  } catch { return null; }
}

function emptyRow(label: string): TokenReportRow {
  return { label, prompt: 0, completion: 0, cached: 0, total: 0,
    observedResults: 0, knownCacheResults: 0, unknownInputResults: 0, unknownCacheResults: 0,
    knownWriteResults: 0, unknownWriteResults: 0, observedInputTokens: 0, coveredInputTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRatio: null, cacheReportingRate: null,
    uncoveredPromptTokens: 0, legacyPromptTokens: 0, historicalCoverage: 'no_data' };
}

const CACHE_COUNT_FIELDS = ['observedResults', 'knownCacheResults', 'unknownInputResults', 'unknownCacheResults',
  'knownWriteResults', 'unknownWriteResults', 'observedInputTokens', 'coveredInputTokens', 'cacheReadTokens',
  'cacheWriteTokens'] as const;

function applyCacheKind(row: TokenRouteReportRow, kind: CacheKind, value: number): void {
  if (kind === 'reported_prompt') row.prompt += value;
  else if (kind === 'reported_completion') row.completion += value;
  else if (kind === 'reported_cached') row.cached += value;
  else if (kind === 'known') { row.observedResults += value; row.knownCacheResults += value; }
  else if (kind === 'input_unknown') {
    row.observedResults += value; row.unknownInputResults += value; row.unknownCacheResults += value;
  } else if (kind === 'cache_unknown') { row.observedResults += value; row.unknownCacheResults += value; }
  else if (kind === 'write_known') row.knownWriteResults += value;
  else if (kind === 'write_unknown') row.unknownWriteResults += value;
  else if (kind === 'observed_input') row.observedInputTokens += value;
  else if (kind === 'covered_input') row.coveredInputTokens += value;
  else if (kind === 'read') row.cacheReadTokens += value;
  else if (kind === 'write') row.cacheWriteTokens += value;
}

function finishRow(row: TokenReportRow, trackedPrompt = row.prompt, trackedCompletion = row.completion,
  trackedCached = row.cached): void {
  row.total = row.prompt + row.completion;
  row.legacyPromptTokens = Math.max(0, row.prompt - trackedPrompt);
  row.uncoveredPromptTokens = Math.max(0, row.prompt - row.coveredInputTokens);
  const historical = row.legacyPromptTokens > 0 || row.completion > trackedCompletion || row.cached > trackedCached;
  row.historicalCoverage = historical ? (row.observedResults ? 'partial' : 'untracked')
    : row.observedResults ? 'tracked' : 'no_data';
  // Only paired versioned observations enter numerator and denominator. Never
  // combine legacy cached tokens with a denominator they were not measured on.
  row.cacheHitRatio = row.coveredInputTokens > 0 ? row.cacheReadTokens / row.coveredInputTokens : null;
  row.cacheReportingRate = row.observedResults > 0 ? row.knownCacheResults / row.observedResults : null;
}

/**
 * 某日(默认今天 UTC)按 provider 汇总的 token 报表。先 flush 保证含最新增量。
 */
export function getTokenReport(date?: string): {
  date: string;
  byLabel: TokenReportRow[];
  byRoute: TokenRouteReportRow[];
  total: TokenReportRow;
  readFailed: boolean;
} {
  flushTokenLedger();
  const d = date ?? utcDate();
  const byLabel = new Map<string, TokenReportRow>();
  const byRoute = new Map<string, TokenRouteReportRow>();
  const total = emptyRow('TOTAL');
  let readFailed = false;
  try {
    const rows = getDb().prepare(
      `SELECT label, usage, kind, SUM(tokens) AS t FROM llm_token_daily WHERE date = ? GROUP BY label, usage, kind`,
    ).all(d) as Array<{ label: string; usage: string; kind: string; t: number }>;
    for (const r of rows) {
      if (!validTokenCount(r.t)) continue;
      const routeKind = parseCacheKind(r.kind);
      if (routeKind) {
        const routeId = JSON.stringify([r.label, r.usage, routeKind.model, routeKind.path]);
        const route = byRoute.get(routeId) ?? { ...emptyRow(r.label), usage: r.usage,
          model: routeKind.model, path: routeKind.path };
        applyCacheKind(route, routeKind.kind, r.t);
        byRoute.set(routeId, route);
        continue;
      }
      if (r.kind !== 'prompt' && r.kind !== 'completion' && r.kind !== 'cached') continue;
      const row = byLabel.get(r.label) ?? emptyRow(r.label);
      if (r.kind === 'prompt') row.prompt += r.t;
      else if (r.kind === 'completion') row.completion += r.t;
      else if (r.kind === 'cached') row.cached += r.t;
      byLabel.set(r.label, row);
    }
    const trackedByLabel = new Map<string, { prompt: number; completion: number; cached: number }>();
    for (const route of byRoute.values()) {
      finishRow(route);
      const row = byLabel.get(route.label) ?? emptyRow(route.label);
      for (const field of CACHE_COUNT_FIELDS) row[field] += route[field];
      const tracked = trackedByLabel.get(route.label) ?? { prompt: 0, completion: 0, cached: 0 };
      tracked.prompt += route.prompt; tracked.completion += route.completion; tracked.cached += route.cached;
      trackedByLabel.set(route.label, tracked);
      byLabel.set(route.label, row);
    }
    let trackedPrompt = 0; let trackedCompletion = 0; let trackedCached = 0;
    for (const row of byLabel.values()) {
      const tracked = trackedByLabel.get(row.label) ?? { prompt: 0, completion: 0, cached: 0 };
      finishRow(row, tracked.prompt, tracked.completion, tracked.cached);
      total.prompt += row.prompt; total.completion += row.completion;
      total.cached += row.cached; total.total += row.total;
      for (const field of CACHE_COUNT_FIELDS) total[field] += row[field];
      trackedPrompt += tracked.prompt; trackedCompletion += tracked.completion; trackedCached += tracked.cached;
    }
    finishRow(total, trackedPrompt, trackedCompletion, trackedCached);
  } catch (err) {
    readFailed = true;
    logger.debug({ err, date: d }, 'getTokenReport query failed');
  }
  return {
    date: d,
    byLabel: [...byLabel.values()].sort((a, b) => b.total - a.total),
    byRoute: [...byRoute.values()].sort((a, b) => b.total - a.total),
    total,
    readFailed,
  };
}
