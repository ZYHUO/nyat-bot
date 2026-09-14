// Deterministic cognitive-event replay.
//
// Replay is read-only by default. Applying projections is explicit so an
// evaluator can inspect a historical stream without mutating live debts or
// predictions, while recovery tooling can opt into the same idempotent
// projector used by the outbox worker.

import { listCognitiveEvents } from './cognitive-events.js';
import type { CognitiveEvent } from './cognitive-events.js';
import { projectCognitiveEvent } from './cognitive-projector.js';
import type { CognitiveProjectionResult, CognitiveProjectionOptions } from './cognitive-projector.js';
import type { CognitiveScope } from '../shared/cognitive-scope.js';

export interface CognitiveReplayOptions {
  correlationId: string;
  scope?: CognitiveScope;
  afterSequence?: number;
  limit?: number;
  applyProjections?: boolean;
  projection?: CognitiveProjectionOptions;
  onEvent?: (event: CognitiveEvent) => void | Promise<void>;
}

export interface CognitiveReplayReport {
  correlationId: string;
  eventIds: string[];
  sequences: number[];
  events: number;
  projectionsApplied: number;
  projectionResults: CognitiveProjectionResult[];
}

/** Replay one causal stream in stable sequence order. */
export async function replayCognitiveCorrelation(
  options: CognitiveReplayOptions,
): Promise<CognitiveReplayReport> {
  const correlationId = options.correlationId.trim();
  if (!correlationId) throw new Error('correlationId is required');
  const events = listCognitiveEvents({
    correlationId,
    scope: options.scope,
    afterSequence: options.afterSequence,
    limit: options.limit,
  });
  const projectionResults: CognitiveProjectionResult[] = [];
  for (const event of events) {
    await options.onEvent?.(event);
    if (options.applyProjections) {
      projectionResults.push(projectCognitiveEvent(event, options.projection));
    }
  }
  return {
    correlationId,
    eventIds: events.map((event) => event.id),
    sequences: events.map((event) => event.sequence),
    events: events.length,
    projectionsApplied: projectionResults.length,
    projectionResults,
  };
}

