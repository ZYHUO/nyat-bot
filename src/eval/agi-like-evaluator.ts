// Offline paired replay evaluator.
//
// This is an engineering harness, not a model benchmark: the caller owns the
// executor and acceptance contract. The evaluator only guarantees that every
// variant sees the same immutable event slice, normalizes bounded host metrics,
// computes paired deltas/confidence intervals, and optionally persists metadata.

import { randomUUID } from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { replayCognitiveCorrelation } from '../agent/replay.js';
import type { CognitiveEvent } from '../agent/cognitive-events.js';
import type { CognitiveReplayReport } from '../agent/replay.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';

export type EvaluationStatus = 'verified' | 'failed' | 'unverified' | 'blocked';
export type EvaluationMode = 'legacy' | 'core';
export type EvaluationScalar = string | number | boolean;

export interface EvaluationVariant {
  id: string;
  mode: EvaluationMode;
  memory: boolean;
  skill: boolean;
  predictionUpdate: boolean;
}

export interface ReplayExperimentCase {
  id: string;
  correlationId: string;
  scope?: CognitiveScope;
  afterSequence?: number;
  limit?: number;
}

export interface EvaluationOutcome {
  status: EvaluationStatus;
  /** A host acceptance check found a false success despite a success claim. */
  falseSuccess?: boolean;
  /** Whether a human had to intervene or clarify for this variant. */
  humanIntervention?: boolean;
  repairAttempts?: number;
  latencyMs?: number;
  llmCalls?: number;
  toolCalls?: number;
  costUsd?: number;
  /** Optional bounded numeric domain metrics, e.g. retention=1 or recovery_ms. */
  metrics?: Record<string, number>;
  /** Stable host error code only; raw exception text is intentionally excluded. */
  errorCode?: string;
}

export interface EvaluationExecutionInput {
  experimentCase: ReplayExperimentCase;
  variant: EvaluationVariant;
  events: readonly CognitiveEvent[];
  replay: CognitiveReplayReport;
}

export type EvaluationExecutor = (input: EvaluationExecutionInput) => EvaluationOutcome | Promise<EvaluationOutcome>;

export interface ConfidenceInterval {
  low: number;
  high: number;
}

export interface VariantAggregate {
  variant: EvaluationVariant;
  samples: number;
  verified: number;
  failed: number;
  unverified: number;
  blocked: number;
  successRate: number;
  successCi95: ConfidenceInterval | null;
  falseSuccess: number;
  falseSuccessRate: number;
  humanInterventions: number;
  interventionRate: number;
  repairAttempts: number;
  meanLatencyMs: number | null;
  p95LatencyMs: number | null;
  meanLlmCalls: number | null;
  meanToolCalls: number | null;
  meanCostUsd: number | null;
  metrics: Record<string, number>;
}

export interface PairedComparison {
  baselineVariantId: string;
  variantId: string;
  samples: number;
  comparable: number;
  baselineWins: number;
  variantWins: number;
  ties: number;
  successDelta: number;
  successCi95: ConfidenceInterval | null;
}

export interface PairedEvaluationCase {
  caseId: string;
  variantId: string;
  correlationId: string;
  eventCount: number;
  eventIds: string[];
  outcome: EvaluationOutcome;
}

export interface EvaluationFailureSample {
  caseId: string;
  variantId: string;
  correlationId: string;
  status: EvaluationStatus;
  falseSuccess: boolean;
  errorCode?: string;
}

export interface EvaluationEvidence {
  /** Null means the caller did not identify the code under test. */
  codeVersion: string | null;
  /** Sanitized, caller-supplied feature/config snapshot; secrets are never inferred. */
  configSnapshot: Record<string, EvaluationScalar>;
  sampleCount: number;
  eventTimeRange: { from: number; to: number } | null;
  /** Null means no stable experiment cohort was supplied. */
  experimentGroup: string | null;
  failureSamples: EvaluationFailureSample[];
  uncertainty: string[];
}

export interface PairedEvaluationReport {
  kind: 'agi_like_paired_replay_engineering_check';
  experimentId: string;
  startedAt: number;
  finishedAt: number;
  cases: PairedEvaluationCase[];
  variants: VariantAggregate[];
  comparisons: PairedComparison[];
  evidence: EvaluationEvidence;
  persisted: boolean;
}

export interface PairedEvaluationOptions {
  cases: ReplayExperimentCase[];
  variants?: EvaluationVariant[];
  execute: EvaluationExecutor;
  experimentId?: string;
  codeVersion?: string;
  experimentGroup?: string;
  configSnapshot?: Record<string, EvaluationScalar>;
  metadata?: Record<string, string | number | boolean>;
  persist?: boolean;
}

const MAX_CASES = 200;
const MAX_VARIANTS = 32;
const MAX_METRIC_KEYS = 24;
const MAX_STRING = 160;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function clampInt(value: unknown, min: number, max: number, fallback = min): number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function clampFinite(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

function boundedId(value: string, label: string): string {
  const id = value.trim().slice(0, 240);
  if (!id) throw new Error(`${label} is required`);
  return id;
}

function optionalLabel(value: string | undefined): string | null {
  const label = value?.trim().slice(0, MAX_STRING);
  return label || null;
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().slice(0, MAX_STRING);
  return /^[A-Za-z0-9_.:-]+$/.test(code) ? code : undefined;
}

function normalizeMetrics(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value).slice(0, MAX_METRIC_KEYS)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key)) continue;
    const number = clampFinite(raw, -1_000_000_000, 1_000_000_000);
    if (number !== undefined) result[key] = number;
  }
  return result;
}

function normalizeMetadata(value: Record<string, EvaluationScalar> | undefined): Record<string, EvaluationScalar> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 24)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(key)) continue;
    if (typeof raw === 'string') result[key] = raw.trim().slice(0, MAX_STRING);
    else if (typeof raw === 'boolean') result[key] = raw;
    else if (typeof raw === 'number' && Number.isFinite(raw)) result[key] = Math.max(-1_000_000_000, Math.min(1_000_000_000, raw));
  }
  return result;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function normalizeOutcome(outcome: EvaluationOutcome): EvaluationOutcome {
  const status: EvaluationStatus = outcome.status === 'verified' || outcome.status === 'failed'
    || outcome.status === 'unverified' || outcome.status === 'blocked'
    ? outcome.status
    : 'blocked';
  return {
    status,
    falseSuccess: outcome.falseSuccess === true,
    humanIntervention: outcome.humanIntervention === true,
    repairAttempts: clampInt(outcome.repairAttempts, 0, 1000),
    ...(clampFinite(outcome.latencyMs, 0, 24 * 60 * 60 * 1000) !== undefined
      ? { latencyMs: clampFinite(outcome.latencyMs, 0, 24 * 60 * 60 * 1000) } : {}),
    ...(clampFinite(outcome.llmCalls, 0, 100_000) !== undefined
      ? { llmCalls: clampFinite(outcome.llmCalls, 0, 100_000) } : {}),
    ...(clampFinite(outcome.toolCalls, 0, 100_000) !== undefined
      ? { toolCalls: clampFinite(outcome.toolCalls, 0, 100_000) } : {}),
    ...(clampFinite(outcome.costUsd, 0, 1_000_000) !== undefined
      ? { costUsd: clampFinite(outcome.costUsd, 0, 1_000_000) } : {}),
    metrics: normalizeMetrics(outcome.metrics),
    ...(safeErrorCode(outcome.errorCode) ? { errorCode: safeErrorCode(outcome.errorCode) } : {}),
  };
}

function defaultVariants(): EvaluationVariant[] {
  return buildAblationMatrix();
}

/** Build the complete 2x2x2x2 legacy/core ablation matrix in stable order. */
export function buildAblationMatrix(): EvaluationVariant[] {
  const variants: EvaluationVariant[] = [];
  for (const mode of ['legacy', 'core'] as const) {
    for (const memory of [false, true]) {
      for (const skill of [false, true]) {
        for (const predictionUpdate of [false, true]) {
          variants.push({
            id: `${mode}-memory-${memory ? 'on' : 'off'}-skill-${skill ? 'on' : 'off'}-prediction-${predictionUpdate ? 'on' : 'off'}`,
            mode,
            memory,
            skill,
            predictionUpdate,
          });
        }
      }
    }
  }
  return variants;
}

function validateVariants(input: EvaluationVariant[]): EvaluationVariant[] {
  if (!Array.isArray(input) || input.length < 2 || input.length > MAX_VARIANTS) {
    throw new Error(`at least 2 and at most ${MAX_VARIANTS} variants are required`);
  }
  const ids = new Set<string>();
  return input.map((variant) => {
    const id = boundedId(variant.id, 'variant id');
    if (ids.has(id)) throw new Error(`duplicate variant id: ${id}`);
    ids.add(id);
    if (variant.mode !== 'legacy' && variant.mode !== 'core') throw new Error(`invalid variant mode: ${id}`);
    return {
      id,
      mode: variant.mode,
      memory: variant.memory === true,
      skill: variant.skill === true,
      predictionUpdate: variant.predictionUpdate === true,
    };
  });
}

function validateCases(input: ReplayExperimentCase[]): ReplayExperimentCase[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_CASES) {
    throw new Error(`between 1 and ${MAX_CASES} cases are required`);
  }
  const ids = new Set<string>();
  return input.map((item) => {
    const id = boundedId(item.id, 'case id');
    if (ids.has(id)) throw new Error(`duplicate case id: ${id}`);
    ids.add(id);
    const correlationId = boundedId(item.correlationId, 'correlationId');
    const afterSequence = item.afterSequence === undefined ? undefined : clampInt(item.afterSequence, 0, 1_000_000);
    const limit = item.limit === undefined ? undefined : clampInt(item.limit, 1, 1000);
    return { id, correlationId, scope: item.scope, afterSequence, limit };
  });
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] ?? null;
  const low = sorted[lower];
  const high = sorted[upper];
  return low === undefined || high === undefined ? null : low + (high - low) * (index - lower);
}

/** Wilson score interval; avoids presenting a zero-sample result as 0% success. */
function proportionCi(successes: number, samples: number): ConfidenceInterval | null {
  if (samples <= 0) return null;
  const z = 1.959963984540054;
  const p = successes / samples;
  const denominator = 1 + (z * z) / samples;
  const center = (p + (z * z) / (2 * samples)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p)) / samples + (z * z) / (4 * samples * samples));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/** Normal approximation for a paired mean difference in the bounded [-1, 1] domain. */
function meanCi95(values: number[]): ConfidenceInterval | null {
  if (!values.length) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  // A single paired case cannot estimate variance; expose the bounded domain
  // instead of presenting a degenerate, misleadingly certain interval.
  if (values.length === 1) return { low: -1, high: 1 };
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
  const margin = 1.959963984540054 * Math.sqrt(variance / values.length);
  return { low: Math.max(-1, average - margin), high: Math.min(1, average + margin) };
}

function aggregate(variant: EvaluationVariant, outcomes: EvaluationOutcome[]): VariantAggregate {
  const verified = outcomes.filter((outcome) => outcome.status === 'verified').length;
  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
  const unverified = outcomes.filter((outcome) => outcome.status === 'unverified').length;
  const blocked = outcomes.filter((outcome) => outcome.status === 'blocked').length;
  const falseSuccess = outcomes.filter((outcome) => outcome.falseSuccess === true).length;
  const humanInterventions = outcomes.filter((outcome) => outcome.humanIntervention === true).length;
  const latencies = outcomes.flatMap((outcome) => outcome.latencyMs === undefined ? [] : [outcome.latencyMs]);
  const llmCalls = outcomes.flatMap((outcome) => outcome.llmCalls === undefined ? [] : [outcome.llmCalls]);
  const toolCalls = outcomes.flatMap((outcome) => outcome.toolCalls === undefined ? [] : [outcome.toolCalls]);
  const costs = outcomes.flatMap((outcome) => outcome.costUsd === undefined ? [] : [outcome.costUsd]);
  const metricValues = new Map<string, number[]>();
  for (const outcome of outcomes) {
    for (const [key, value] of Object.entries(outcome.metrics ?? {})) {
      const values = metricValues.get(key) ?? [];
      values.push(value);
      metricValues.set(key, values);
    }
  }
  const metrics: Record<string, number> = {};
  for (const [key, values] of metricValues) {
    const value = mean(values);
    if (value !== null) metrics[key] = value;
  }
  return {
    variant,
    samples: outcomes.length,
    verified,
    failed,
    unverified,
    blocked,
    successRate: outcomes.length ? verified / outcomes.length : 0,
    successCi95: proportionCi(verified, outcomes.length),
    falseSuccess,
    falseSuccessRate: outcomes.length ? falseSuccess / outcomes.length : 0,
    humanInterventions,
    interventionRate: outcomes.length ? humanInterventions / outcomes.length : 0,
    repairAttempts: outcomes.reduce((sum, outcome) => sum + (outcome.repairAttempts ?? 0), 0),
    meanLatencyMs: mean(latencies),
    p95LatencyMs: percentile(latencies, 0.95),
    meanLlmCalls: mean(llmCalls),
    meanToolCalls: mean(toolCalls),
    meanCostUsd: mean(costs),
    metrics,
  };
}

function compare(
  baselineVariantId: string,
  variantId: string,
  caseIds: string[],
  outcomes: Map<string, EvaluationOutcome>,
): PairedComparison {
  let comparable = 0;
  let baselineWins = 0;
  let variantWins = 0;
  let ties = 0;
  const differences: number[] = [];
  for (const caseId of caseIds) {
    const baseline = outcomes.get(`${caseId}\u0000${baselineVariantId}`);
    const variant = outcomes.get(`${caseId}\u0000${variantId}`);
    if (!baseline || !variant || baseline.status === 'blocked' || variant.status === 'blocked') continue;
    comparable++;
    const baselineSuccess = baseline.status === 'verified' ? 1 : 0;
    const variantSuccess = variant.status === 'verified' ? 1 : 0;
    const difference = variantSuccess - baselineSuccess;
    differences.push(difference);
    if (difference > 0) variantWins++;
    else if (difference < 0) baselineWins++;
    else ties++;
  }
  const delta = comparable ? differences.reduce((sum, value) => sum + value, 0) / comparable : 0;
  return {
    baselineVariantId,
    variantId,
    samples: caseIds.length,
    comparable,
    baselineWins,
    variantWins,
    ties,
    successDelta: delta,
    successCi95: meanCi95(differences),
  };
}

function hasTable(name: string): boolean {
  try {
    return Boolean(getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  } catch {
    return false;
  }
}

function boundedJson(value: unknown, maxBytes: number): string {
  try {
    const json = JSON.stringify(value);
    return json.length <= maxBytes ? json : JSON.stringify({ truncated: true });
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function failureSamples(cases: PairedEvaluationCase[]): EvaluationFailureSample[] {
  return cases
    .filter((item) => item.outcome.status !== 'verified' || item.outcome.falseSuccess === true)
    .slice(0, 100)
    .map((item) => ({
      caseId: item.caseId,
      variantId: item.variantId,
      correlationId: item.correlationId,
      status: item.outcome.status,
      falseSuccess: item.outcome.falseSuccess === true,
      ...(item.outcome.errorCode ? { errorCode: item.outcome.errorCode } : {}),
    }));
}

function evidenceUncertainty(evidence: Omit<EvaluationEvidence, 'uncertainty'>): string[] {
  const reasons: string[] = [];
  if (!evidence.codeVersion) reasons.push('code_version_missing');
  if (Object.keys(evidence.configSnapshot).length === 0) reasons.push('config_snapshot_missing');
  if (!evidence.experimentGroup) reasons.push('experiment_group_missing');
  if (!evidence.eventTimeRange) reasons.push('event_time_range_missing');
  if (evidence.sampleCount < 2) reasons.push('small_sample');
  if (evidence.failureSamples.some((sample) => sample.status === 'blocked')) reasons.push('blocked_cases_present');
  if (evidence.failureSamples.some((sample) => sample.falseSuccess)) reasons.push('false_success_present');
  return reasons;
}

function persistReport(report: PairedEvaluationReport, metadata?: PairedEvaluationOptions['metadata']): boolean {
  if (!hasTable('replay_experiments') || !hasTable('replay_experiment_cases')) return false;
  try {
    const db = getDb();
    const config = {
      variants: report.variants.map((item) => item.variant),
      metadata: normalizeMetadata(metadata),
      evidence: report.evidence,
      comparisons: report.comparisons.map((item) => ({
        baselineVariantId: item.baselineVariantId,
        variantId: item.variantId,
        comparable: item.comparable,
        successDelta: item.successDelta,
      })),
    };
    const transaction = db.transaction(() => {
      db.prepare(
        `INSERT INTO replay_experiments (id, kind, code_version, config_json, started_at, finished_at, created_at)
         VALUES (?, 'paired_replay', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET code_version = excluded.code_version,
           config_json = excluded.config_json, finished_at = excluded.finished_at`,
      ).run(report.experimentId, report.evidence.codeVersion, boundedJson(config, 16_000), report.startedAt, report.finishedAt, report.startedAt);
      const insert = db.prepare(
        `INSERT INTO replay_experiment_cases
           (experiment_id, case_id, variant_id, status, false_success, human_intervention, metrics_json, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(experiment_id, case_id, variant_id) DO UPDATE SET status = excluded.status,
           false_success = excluded.false_success, human_intervention = excluded.human_intervention,
           metrics_json = excluded.metrics_json, error_code = excluded.error_code`,
      );
      for (const item of report.cases) {
        insert.run(
          report.experimentId,
          item.caseId,
          item.variantId,
          item.outcome.status,
          item.outcome.falseSuccess ? 1 : 0,
          item.outcome.humanIntervention ? 1 : 0,
          boundedJson({
            repairAttempts: item.outcome.repairAttempts ?? 0,
            latencyMs: item.outcome.latencyMs,
            llmCalls: item.outcome.llmCalls,
            toolCalls: item.outcome.toolCalls,
            costUsd: item.outcome.costUsd,
            metrics: item.outcome.metrics ?? {},
          }, 4000),
          item.outcome.errorCode ?? null,
          report.startedAt,
        );
      }
    });
    transaction();
    return true;
  } catch (err) {
    logger.debug({ err, experimentId: report.experimentId }, 'paired evaluation persist failed');
    return false;
  }
}

/**
 * Run every supplied variant against the same preloaded event slice.
 * Executor failures become `blocked` cases so one broken adapter cannot erase
 * the rest of a report; raw exception messages never enter the report/storage.
 */
export async function runPairedReplayEvaluation(options: PairedEvaluationOptions): Promise<PairedEvaluationReport> {
  const cases = validateCases(options.cases);
  const variants = validateVariants(options.variants ?? defaultVariants());
  if (typeof options.execute !== 'function') throw new Error('execute is required');
  const experimentId = options.experimentId ? boundedId(options.experimentId, 'experimentId') : randomUUID();
  const startedAt = nowSec();
  const pairedCases: PairedEvaluationCase[] = [];
  const outcomes = new Map<string, EvaluationOutcome>();
  let eventTimeFrom = Number.POSITIVE_INFINITY;
  let eventTimeTo = 0;

  for (const experimentCase of cases) {
    const eventObjects: CognitiveEvent[] = [];
    const replay = await replayCognitiveCorrelation({
      correlationId: experimentCase.correlationId,
      scope: experimentCase.scope,
      afterSequence: experimentCase.afterSequence,
      limit: experimentCase.limit,
      onEvent: (event) => { eventObjects.push(event); },
    });
    // The callback above captures the event objects while the replay API fixes
    // their ordering. Every variant below receives this exact frozen array.
    if (eventObjects.length !== replay.events) {
      throw new Error(`replay stream changed while loading case ${experimentCase.id}`);
    }
    const stableEvents = Object.freeze(eventObjects.map((event) => deepFreeze(event))) as readonly CognitiveEvent[];
    for (const event of stableEvents) {
      if (Number.isSafeInteger(event.occurredAt) && event.occurredAt > 0) {
        eventTimeFrom = Math.min(eventTimeFrom, event.occurredAt);
        eventTimeTo = Math.max(eventTimeTo, event.occurredAt);
      }
    }
    for (const variant of variants) {
      let outcome: EvaluationOutcome;
      try {
        outcome = normalizeOutcome(await options.execute({
          experimentCase,
          variant,
          events: stableEvents,
          replay: { ...replay, projectionResults: [] },
        }));
      } catch {
        outcome = { status: 'blocked', falseSuccess: false, humanIntervention: false, repairAttempts: 0, metrics: {}, errorCode: 'executor_error' };
      }
      outcomes.set(`${experimentCase.id}\u0000${variant.id}`, outcome);
      pairedCases.push({
        caseId: experimentCase.id,
        variantId: variant.id,
        correlationId: experimentCase.correlationId,
        eventCount: stableEvents.length,
        eventIds: stableEvents.map((event) => event.id),
        outcome,
      });
    }
  }

  const aggregates = variants.map((variant) => aggregate(
    variant,
    cases.map((experimentCase) => outcomes.get(`${experimentCase.id}\u0000${variant.id}`)!).filter(Boolean),
  ));
  const baselineVariantId = variants[0]!.id;
  const comparisons = variants.slice(1).map((variant) => compare(
    baselineVariantId,
    variant.id,
    cases.map((experimentCase) => experimentCase.id),
    outcomes,
  ));
  const evidenceBase: Omit<EvaluationEvidence, 'uncertainty'> = {
    codeVersion: optionalLabel(options.codeVersion),
    configSnapshot: normalizeMetadata(options.configSnapshot),
    sampleCount: cases.length,
    eventTimeRange: eventTimeTo > 0 && Number.isFinite(eventTimeFrom)
      ? { from: eventTimeFrom, to: eventTimeTo }
      : null,
    experimentGroup: optionalLabel(options.experimentGroup),
    failureSamples: failureSamples(pairedCases),
  };
  const report: PairedEvaluationReport = {
    kind: 'agi_like_paired_replay_engineering_check',
    experimentId,
    startedAt,
    finishedAt: nowSec(),
    cases: pairedCases,
    variants: aggregates,
    comparisons,
    evidence: { ...evidenceBase, uncertainty: evidenceUncertainty(evidenceBase) },
    persisted: false,
  };
  if (options.persist) report.persisted = persistReport(report, options.metadata);
  return report;
}
