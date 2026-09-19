// Belief verification: closing the loop between "the world changed" and "this
// belief is now wrong".
//
// THE GAP THIS FILLS
//
// Three pieces existed and none of them met:
//   1. `world-facts.ts` emits `world_change` events when Telegram reports a
//      different group title / description / member count.
//   2. `cognitive-projector.ts` turns each one into a `stale_belief` debt —
//      "世界状态发生变化，相关旧信念需要重新验证".
//   3. `contradict.ts` can mark a belief contradicted, and `getActiveBeliefs()`
//      already excludes those from prompts.
//
// Measured 2026-09-19: 20 `stale_belief` debts open, 207 beliefs all `active`,
// `user_correction` events zero. The debts were being created and never read, so
// a belief that the world had invalidated stayed in the prompt forever.
//
// HOW THIS DECIDES
//
// `contradict.ts` requires non-empty evidence and is documented as "host 调用" —
// the model must not be allowed to refute a belief on its own say-so. So this
// pass only contradicts a belief when the host has a concrete, quotable fact:
// the `world_change` event that raised the debt. Everything else is left alone.
//
// Fail-soft throughout: a verification pass that cannot decide must change
// nothing, never guess.

import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { env } from '../env.js';
import { contradict } from '../core/beliefs/contradict.js';

export interface VerificationResult {
  /** Debts examined. */
  examined: number;
  /** Beliefs actually marked contradicted. */
  contradicted: number;
  /** Debts closed because nothing contradicted them. */
  cleared: number;
}

/** How many debts to work through per pass. */
const BATCH = 20;
const MAX_EVIDENCE = 200;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Pull the concrete fact behind a `world_change` event, for use as evidence.
 *
 * Returns null when the event is missing or carries no usable fact — in which
 * case the belief is left alone. "We could not check" must never be recorded as
 * "we checked and it was wrong".
 */
function evidenceFromEvent(eventId: string): string | null {
  try {
    const row = getDb().prepare(
      `SELECT type, fact_json FROM cognitive_events WHERE id = ?`,
    ).get(eventId) as { type: string; fact_json: string } | undefined;
    if (!row || row.type !== 'world_change') return null;
    const fact = JSON.parse(row.fact_json) as Record<string, unknown>;
    const props = fact['properties'];
    if (!props || typeof props !== 'object') return null;
    const pairs = Object.entries(props as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string' && v)
      .slice(0, 4)
      .map(([k, v]) => `${k}=${String(v).slice(0, 60)}`);
    if (pairs.length === 0) return null;
    const name = typeof fact['entityName'] === 'string' ? fact['entityName'] : '';
    return `世界事实变更：${name ? `${name} ` : ''}${pairs.join(', ')}`.slice(0, MAX_EVIDENCE);
  } catch {
    return null;
  }
}

/**
 * Does the belief actually depend on the fact that changed?
 *
 * Getting this wrong is expensive in the quiet direction: an over-broad check
 * contradicts beliefs at random and empties the prompt, while an over-narrow one
 * leaves stale beliefs in place. Both are worse than doing nothing, so the rule
 * is deliberately strict.
 *
 * Measured 2026-09-19 (first live run): a name-overlap check contradicted three
 * beliefs of the form "「某群名」（place）" because the `world_change` event was
 * CONFIRMING that same title. Confirmation is not contradiction — the belief
 * "this group is called X" is *supported* by an event saying "title=X".
 *
 * So the belief must be about the property that changed AND the change must be
 * genuinely new information. A belief whose summary already contains the new
 * value is evidence FOR it, not against it.
 */
function beliefContradictedByChange(beliefSummary: string, eventId: string): boolean {
  try {
    const row = getDb().prepare(
      `SELECT fact_json FROM cognitive_events WHERE id = ?`,
    ).get(eventId) as { fact_json: string } | undefined;
    if (!row) return false;
    const fact = JSON.parse(row.fact_json) as Record<string, unknown>;
    const entity = typeof fact['entityName'] === 'string' ? fact['entityName'] : '';
    const props = fact['properties'];
    if (!props || typeof props !== 'object') return false;
    const pairs = Object.entries(props as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string' && v) as Array<[string, string]>;
    if (pairs.length === 0) return false;

    const summary = beliefSummary.toLowerCase();
    const entityLower = entity.toLowerCase();

    // Does the belief even talk about this entity?
    if (!entityLower || !summary.includes(entityLower.slice(0, Math.min(12, entityLower.length)))) {
      return false;
    }

    // Strip the entity mention before looking for a stated value: a summary
    // beginning with the entity name ("dorocloud 这个群叫…") is naming the
    // subject, not asserting the title.
    const withoutEntity = entityLower
      ? summary.split(entityLower).join(' ')
      : summary;

    // If the stated value appears outside the entity mention, the belief is
    // CONSISTENT with the change — an event reporting title=X supports a belief
    // that says the title is X.
    const statesNewValue = pairs.some(([, v]) => {
      const val = v.toLowerCase();
      return val.length >= 2 && withoutEntity.includes(val.slice(0, 24));
    });
    if (statesNewValue) return false;

    // Only a belief that asserts a property of this entity is a candidate.
    // Merely mentioning the entity is not enough — that would contradict every
    // belief that happens to name the group.
    const propertyWords = ['叫', '名字', '标题', 'title', '属于', '位于', '类型'];
    return propertyWords.some((w) => summary.includes(w));
  } catch {
    return false;
  }
}

/**
 * Run one verification pass over open `stale_belief` debts.
 *
 * A debt is closed either way: contradicted beliefs have been dealt with, and
 * beliefs that survive the check no longer need re-checking. Leaving debts open
 * forever is what made the original gap invisible.
 */
export function verifyStaleBeliefs(limit = BATCH): VerificationResult {
  const result: VerificationResult = { examined: 0, contradicted: 0, cleared: 0 };
  if (!env().BELIEF_VERIFY_ENABLED) return result;
  try {
    const db = getDb();
    const debts = db.prepare(
      `SELECT id, scope_key, statement, source_event_ids
       FROM cognitive_debts
       WHERE kind = 'stale_belief' AND status = 'open'
       ORDER BY priority DESC, created_at ASC LIMIT ?`,
    ).all(Math.min(200, Math.max(1, limit))) as Array<{
      id: number; scope_key: string | null; statement: string;
      source_event_ids: string | null;
    }>;
    if (debts.length === 0) return result;

    for (const debt of debts) {
      result.examined += 1;
      // `source_event_ids` is a JSON array; take the first usable id.
      let eventId: string | null = null;
      try {
        const parsed = JSON.parse(debt.source_event_ids ?? '[]') as unknown;
        if (Array.isArray(parsed)) {
          const first = parsed.find((v) => typeof v === 'string' && v);
          if (typeof first === 'string') eventId = first;
        }
      } catch { /* no provenance */ }
      if (!eventId) {
        // No provenance → cannot check → leave it open rather than guess.
        continue;
      }
      const evidence = evidenceFromEvent(eventId);
      if (!evidence) continue;

      // Which beliefs does this debt's scope cover?
      const subjectKey = debt.scope_key ?? '';
      const beliefs = db.prepare(
        `SELECT id, summary FROM core_beliefs
         WHERE status = 'active' AND (scope_key = ? OR ? = '')
         LIMIT 20`,
      ).all(subjectKey, subjectKey) as Array<{ id: number; summary: string }>;

      let touched = 0;
      for (const belief of beliefs) {
        if (!beliefContradictedByChange(belief.summary, eventId)) continue;
        try {
          contradict(belief.id, [evidence], `世界事实变更后重新验证（debt ${debt.id}）`);
          touched += 1;
          result.contradicted += 1;
          logger.info(
            { beliefId: belief.id, debtId: debt.id, evidence: evidence.slice(0, 80) },
            'belief verification: contradicted by world change',
          );
        } catch (err) {
          logger.debug({ err, beliefId: belief.id }, 'belief verification: contradict failed');
        }
      }

      // The debt is discharged either way — checked and acted on, or checked and
      // the belief survived. Keeping it open forever is how this went unnoticed.
      db.prepare(
        `UPDATE cognitive_debts SET status = 'resolved', resolution = ?, updated_at = ? WHERE id = ?`,
      ).run(touched > 0 ? `contradicted ${touched}` : 'verified_no_conflict', nowSec(), debt.id);
      result.cleared += 1;
    }

    if (result.examined > 0) {
      logger.info(result, 'belief verification pass complete');
    }
    return result;
  } catch (err) {
    logger.warn({ err }, 'verifyStaleBeliefs failed (non-critical)');
    return result;
  }
}
