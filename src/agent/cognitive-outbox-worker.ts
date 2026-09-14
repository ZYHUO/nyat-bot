// Durable outbox consumer for cognitive events.
// The worker owns leases and retry state; handlers must be idempotent because a
// process can die after handling an item but before acknowledging it.

import { randomUUID } from 'node:crypto';
import {
  ackCognitiveOutbox,
  claimCognitiveOutbox,
  failCognitiveOutbox,
} from './cognitive-events.js';
import type { CognitiveOutboxItem } from './cognitive-events.js';
import { logger } from '../shared/logger.js';

export type CognitiveOutboxHandler = (item: CognitiveOutboxItem) => void | Promise<void>;

export interface DrainCognitiveOutboxOptions {
  workerId?: string;
  batchSize?: number;
  leaseSec?: number;
  retryInSec?: number | ((error: unknown, item: CognitiveOutboxItem) => number);
  maxAttempts?: number;
}

export interface DrainCognitiveOutboxResult {
  claimed: number;
  delivered: number;
  retried: number;
  failed: number;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 500) || 'outbox handler failed';
}

function positiveInt(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

/** Drain one bounded batch. Safe to call after a crash or from a scheduler tick. */
export async function drainCognitiveOutbox(
  handler: CognitiveOutboxHandler,
  options: DrainCognitiveOutboxOptions = {},
): Promise<DrainCognitiveOutboxResult> {
  const workerId = options.workerId?.trim().slice(0, 120) || `cognitive-worker:${randomUUID()}`;
  const batchSize = positiveInt(options.batchSize, 20, 200);
  const leaseSec = positiveInt(options.leaseSec, 60, 3600);
  const maxAttempts = options.maxAttempts === undefined
    ? undefined
    : positiveInt(options.maxAttempts, 5, 100);
  const claimed = claimCognitiveOutbox(workerId, batchSize, leaseSec);
  const result: DrainCognitiveOutboxResult = { claimed: claimed.length, delivered: 0, retried: 0, failed: 0 };

  for (const item of claimed) {
    try {
      if (!item.event) throw new Error('cognitive event missing for outbox item');
      await handler(item);
      if (ackCognitiveOutbox(item.id, workerId)) {
        result.delivered += 1;
      } else {
        // A lease was lost or another worker settled the item. It is not safe to
        // count this as delivered, but do not attempt a second state transition.
        logger.debug({ outboxId: item.id, workerId }, 'cognitive outbox ack lost race');
      }
    } catch (error) {
      const message = errorText(error);
      const exhausted = maxAttempts !== undefined && item.attempts >= maxAttempts;
      const retryValue = typeof options.retryInSec === 'function'
        ? options.retryInSec(error, item)
        : options.retryInSec ?? 30;
      const retryInSec = exhausted ? 0 : Math.max(0, Math.trunc(retryValue));
      const settled = failCognitiveOutbox(item.id, message, retryInSec, workerId);
      if (settled && retryInSec > 0) result.retried += 1;
      else if (settled) result.failed += 1;
      logger.warn({ err: error, outboxId: item.id, attempts: item.attempts, retryInSec }, 'cognitive outbox handler failed');
    }
  }
  return result;
}

export interface CognitiveOutboxWorkerOptions extends DrainCognitiveOutboxOptions {
  pollMs?: number;
}

/**
 * Optional long-lived wrapper. Nothing starts implicitly; callers decide when
 * a projection consumer is safe to enable and can stop it during shutdown.
 */
export class CognitiveOutboxWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private draining = false;
  private readonly options: CognitiveOutboxWorkerOptions;

  constructor(private readonly handler: CognitiveOutboxHandler, options: CognitiveOutboxWorkerOptions = {}) {
    this.options = { ...options };
  }

  start(): boolean {
    if (this.running) return false;
    const pollMs = positiveInt(this.options.pollMs, 1000, 60_000);
    this.running = true;
    void this.drain();
    this.timer = setInterval(() => { void this.drain(); }, pollMs);
    this.timer.unref?.();
    return true;
  }

  stop(): boolean {
    if (!this.running) return false;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return true;
  }

  isRunning(): boolean {
    return this.running;
  }

  async drain(): Promise<DrainCognitiveOutboxResult> {
    if (this.draining) return { claimed: 0, delivered: 0, retried: 0, failed: 0 };
    this.draining = true;
    try {
      return await drainCognitiveOutbox(this.handler, this.options);
    } finally {
      this.draining = false;
    }
  }
}

