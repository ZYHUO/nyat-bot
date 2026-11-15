import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { deleteLexical, upsertLexical } from './lexical.js';
import { claimMemoryProjection, currentProjection, checkpointMemoryVector, completeMemoryProjection, failMemoryProjection } from './source-store.js';
import type { MemoryProjectionJob, MemorySource } from './source-store.js';

export interface MemoryProjectionAdapter {
  embed(text: string): Promise<number[]>;
  upsert(source: MemorySource, job: MemoryProjectionJob, vector: number[]): Promise<void>;
  remove(source: MemorySource, job: MemoryProjectionJob): Promise<void>;
}

class ProjectionTimeout extends Error {}
async function boundedStep<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProjectionTimeout()), 20_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** One SQLite authority may have concurrent workers; every step is lease-fenced.
 * Versioned vector IDs mean a late old write cannot overwrite the new version.
 */
export async function drainMemoryProjections(adapter: MemoryProjectionAdapter, batchSize = 10): Promise<{ claimed: number; completed: number; failed: number; superseded: number }> {
  const result = { claimed: 0, completed: 0, failed: 0, superseded: 0 };
  if (env().MEMORY_PROJECTION_OUTBOX_ENABLED !== true) return result;
  const started = Date.now();
  for (let i = 0; i < Math.min(Math.max(batchSize, 1), 50); i++) {
    if (Date.now() - started >= 20_000) break;
    const job = claimMemoryProjection(); if (!job) break;
    result.claimed++;
    let stage = 'source';
    try {
      const source = currentProjection(job);
      if (!source) { result.superseded++; continue; }
      if (!job.vector_done) {
        if (source.tombstone) {
          stage = 'vector_delete';
          await boundedStep(adapter.remove(source, job));
        } else {
          stage = 'embedding';
          const vector = await boundedStep(adapter.embed(source.text_body));
          if (!vector.length || vector.some(value => !Number.isFinite(value))) throw new Error('invalid_vector');
          if (!currentProjection(job)) { result.superseded++; continue; }
          stage = 'vector_write';
          await boundedStep(adapter.upsert(source, job, vector));
        }
        if (!checkpointMemoryVector(job)) { result.superseded++; continue; }
      }
      stage = 'lexical';
      const completed = completeMemoryProjection(job, current => {
        if (current.tombstone) {
          const ids = getDb().prepare('SELECT projection_id FROM memory_projection_jobs WHERE source_id=?').all(current.source_id) as Array<{ projection_id: string }>;
          deleteLexical(getDb(), [current.legacy_id, ...ids.map(row => row.projection_id)]);
        } else {
          // FTS is a durable projection even if its read feature is off today.
          upsertLexical(getDb(), job.projection_id, current.chat_id, current.text_body);
          const old = getDb().prepare('SELECT projection_id FROM memory_projection_jobs WHERE source_id=? AND version<?').all(current.source_id, current.version) as Array<{ projection_id: string }>;
          deleteLexical(getDb(), [current.legacy_id, ...old.map(row => row.projection_id)]);
        }
      });
      if (completed) result.completed++; else result.superseded++;
    } catch (error) {
      // No provider exception/body/credential in durable diagnostic fields.
      failMemoryProjection(job, `${stage}_${error instanceof ProjectionTimeout ? 'timeout' : 'failed'}`);
      result.failed++;
    }
  }
  return result;
}
