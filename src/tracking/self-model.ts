// Candidates are observations for review. Only an explicit, persisted host
// decision can promote a note, and chat-derived notes remain in that chat.
import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '../db/sqlite.js';
import { logger } from '../shared/logger.js';
import { getCognitiveEvent } from '../agent/cognitive-events.js';
import { scopeKey, type CognitiveScope } from '../shared/cognitive-scope.js';
import { resolveConversationScope, type ConversationScope } from '../shared/privacy-scope.js';

export interface SelfNote {
  id: number;
  note: string;
  evidence: string | null;
  created_at: number;
  verified?: number;
  scopeKey?: string;
}

type NoteInput = { note: string; evidence?: string };
export interface SelfNoteCandidateContext {
  origin: 'self_reflect' | 'feedback_aggregate';
  /** Source metadata only. Mixed samples never imply global disclosure. */
  sourceChatIds: readonly number[];
}
type VerifiedSelfNoteInput = {
  sourceEventId: string;
  source: 'host' | 'tool' | 'telegram' | 'scheduler' | 'import';
  scope: CognitiveScope;
  evidence: Record<string, unknown>;
};

function nowSec(): number { return Math.floor(Date.now() / 1000); }
function boundedCount(value: number, max = 100): number {
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(max, value)) : 0;
}
function hasTable(table: string): boolean {
  try {
    return Boolean(getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  } catch { return false; }
}
function cleanNote(value: NoteInput): { note: string; evidence: string | null } | null {
  const note = typeof value.note === 'string' ? value.note.trim().slice(0, 300) : '';
  return note.length < 4 ? null : { note, evidence: value.evidence?.trim().slice(0, 500) || null };
}
function sameConversation(value: unknown, target: ConversationScope): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return target.accountId !== null && source['chatId'] === target.chatId
    && source['platform'] === target.platform && source['accountId'] === target.accountId
    && source['conversationKind'] === target.conversationKind;
}
function evidenceMatches(observed: unknown, claimed: Record<string, unknown>): boolean {
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return false;
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(observed).slice(0, 20)) {
    const safeKey = key.replace(/\p{Cc}/gu, '').trim().slice(0, 80);
    if (!safeKey) continue;
    if (typeof value === 'string') bounded[safeKey] = value.replace(/\p{Cc}/gu, '').trim().slice(0, 240);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) bounded[safeKey] = value;
  }
  const entries = Object.entries(claimed);
  return entries.length > 0 && entries.every(([key, value]) => bounded[key] === value);
}

/** Persist unverified notes for review, never as prompt instructions. */
export function saveSelfNotes(notes: readonly NoteInput[], context?: SelfNoteCandidateContext): number {
  try {
    const db = getDb(), ts = nowSec();
    const sources = [...new Set(context?.sourceChatIds ?? [])].slice(0, 10)
      .map(resolveConversationScope).filter((value): value is ConversationScope => value !== null);
    const key = sources.length === 1 ? `chat:${sources[0]!.chatId}` : 'candidate:unscoped';
    return db.transaction(() => {
      let saved = 0;
      for (const input of notes.slice(0, 5)) {
        const item = cleanNote(input);
        if (!item) continue;
        const row = db.prepare('INSERT INTO self_model_notes (note, evidence, created_at) VALUES (?, ?, ?)')
          .run(item.note, item.evidence, ts);
        if (hasTable('self_model_note_provenance')) {
          db.prepare(`INSERT INTO self_model_note_provenance
            (note_id, state, scope_key, conversation_json, source_refs_json, origin)
            VALUES (?, 'candidate', ?, NULL, ?, ?)`).run(
            Number(row.lastInsertRowid), key, JSON.stringify(sources), context?.origin ?? 'legacy_candidate',
          );
        }
        if (hasTable('hypothesis_update_audit')) {
          db.prepare(`INSERT INTO hypothesis_update_audit
            (idempotency_key, kind, scope_key, subject_key, source_event_id, source,
             status, reason, evidence_json, counterevidence_json, created_at)
            VALUES (?, 'self', ?, 'bot', NULL, 'model', 'candidate', ?, ?, '[]', ?)`).run(
            `self-candidate:${randomUUID()}`, key, 'unverified candidate; no disclosure authority',
            JSON.stringify(item), ts,
          );
        }
        saved++;
      }
      return saved;
    })();
  } catch (err) {
    logger.warn({ err }, 'saveSelfNotes failed');
    return 0;
  }
}

/**
 * The projector supplies a real host decision event. Its exact notes and scope
 * must match; an arbitrary event ID or model's evidence text is not authority.
 * No historical account is inferred from today's Telegram credential.
 */
export function saveVerifiedSelfNotes(notes: readonly NoteInput[], provenance: VerifiedSelfNoteInput): number {
  if (!hasTable('self_model_note_evidence') || !hasTable('self_model_note_provenance')
    || !hasTable('self_model_note_promotions')) return 0;
  try {
    const key = scopeKey(provenance.scope);
    const event = getCognitiveEvent(provenance.sourceEventId);
    if (!event || event.source === 'model' || event.source !== provenance.source || event.scopeKey !== key
      || event.fact['hypothesisKind'] !== 'self' || !evidenceMatches(event.fact['evidence'], provenance.evidence ?? {})) return 0;
    // User/task-scoped hypotheses need their own consumer context. They must not
    // be silently widened into a chat-only prompt reader.
    if (provenance.scope.visibility !== 'global' && provenance.scope.visibility !== 'chat') return 0;
    const conversation = provenance.scope.visibility === 'chat'
      ? resolveConversationScope(provenance.scope.chatId!) : null;
    if (provenance.scope.visibility === 'chat'
      && (!conversation || event.chatId !== conversation.chatId
        || !sameConversation(event.fact['conversationScope'], conversation))) return 0;
    if (provenance.scope.visibility === 'global'
      && (event.chatId !== null || event.fact['selfNoteGlobalApproved'] !== true)) return 0;
    const approved = event.fact['notes'];
    if (!Array.isArray(approved)) return 0;
    const normalized = notes.slice(0, 5).map(cleanNote).filter((n): n is NonNullable<typeof n> => n !== null);
    if (!normalized.length || normalized.some((note) => !approved.some((value: unknown) => {
      if (!value || typeof value !== 'object' || typeof (value as NoteInput).note !== 'string') return false;
      const candidate = cleanNote(value as NoteInput);
      return candidate?.note === note.note && candidate.evidence === note.evidence;
    }))) return 0;

    const db = getDb(), ts = nowSec();
    return db.transaction(() => {
      let accepted = 0;
      for (const note of normalized) {
        const hash = createHash('sha256').update(JSON.stringify(note)).digest('hex');
        const prior = db.prepare('SELECT note_id FROM self_model_note_promotions WHERE source_event_id = ? AND note_hash = ? AND scope_key = ?')
          .get(event.id, hash, key);
        // Receipts survive note retention. Replay cannot resurrect an expired note.
        if (prior) { accepted++; continue; }
        const inserted = db.prepare('INSERT INTO self_model_notes (note, evidence, created_at) VALUES (?, ?, ?)')
          .run(note.note, note.evidence, ts);
        const id = Number(inserted.lastInsertRowid);
        db.prepare(`INSERT INTO self_model_note_evidence (note_id, source_event_id, source, evidence_json, verified_at)
          VALUES (?, ?, ?, ?, ?)`).run(id, event.id, event.source, JSON.stringify(provenance.evidence), ts);
        db.prepare(`INSERT INTO self_model_note_provenance
          (note_id, state, scope_key, conversation_json, source_refs_json, origin)
          VALUES (?, 'verified', ?, ?, '[]', 'host_decision')`).run(id, key, conversation ? JSON.stringify(conversation) : null);
        db.prepare(`INSERT INTO self_model_note_promotions (source_event_id, note_hash, scope_key, note_id, verified_at)
          VALUES (?, ?, ?, ?, ?)`).run(event.id, hash, key, id, ts);
        accepted++;
      }
      return accepted;
    })();
  } catch (err) {
    logger.warn({ err }, 'saveVerifiedSelfNotes failed');
    return 0;
  }
}

/** Only approved global notes or exact account/chat notes reach chat prompts. */
export function getActiveSelfNotes(limit = 5, asOfSec?: number, chatId?: number): SelfNote[] {
  if (!hasTable('self_model_note_evidence') || !hasTable('self_model_note_provenance')) return [];
  try {
    const target = chatId === undefined ? null : resolveConversationScope(chatId);
    if (chatId !== undefined && (!target || target.accountId === null)) return [];
    const keys = target ? ['global', `chat:${target.chatId}`] : ['global'];
    const asOf = Number.isSafeInteger(asOfSec) && asOfSec! > 0 ? asOfSec! : nowSec();
    // Authorization precedes LIMIT: unrelated chats cannot crowd out this chat.
    return getDb().prepare(`SELECT n.*, 1 AS verified, p.scope_key AS scopeKey FROM self_model_notes n
      JOIN self_model_note_evidence e ON e.note_id = n.id
      JOIN self_model_note_provenance p ON p.note_id = n.id
      WHERE p.state = 'verified' AND p.scope_key IN (${keys.map(() => '?').join(',')})
        AND (p.scope_key = 'global' OR p.conversation_json = ?)
        AND n.created_at <= ? AND e.verified_at <= ?
      ORDER BY n.created_at DESC, n.id DESC LIMIT ?`).all(
      ...keys, target ? JSON.stringify(target) : '', asOf, asOf, boundedCount(limit),
    ) as SelfNote[];
  } catch (err) {
    logger.debug({ err }, 'getActiveSelfNotes failed (non-fatal)');
    return [];
  }
}

/** Candidate and verified retention are independent, and active scopes do not compete. */
export function pruneSelfNotes(keepCandidates = 20, keepVerified = 20): void {
  if (!hasTable('self_model_note_evidence') || !hasTable('self_model_note_provenance')) return;
  try {
    const db = getDb();
    db.transaction(() => {
      db.prepare(`DELETE FROM self_model_notes WHERE id IN (
        SELECT n.id FROM self_model_notes n LEFT JOIN self_model_note_evidence e ON e.note_id = n.id
        WHERE e.note_id IS NULL ORDER BY n.created_at DESC, n.id DESC LIMIT -1 OFFSET ?
      )`).run(boundedCount(keepCandidates, 1000));
      // Legacy verified rows have no proven scope and stay archived, never injected.
      db.prepare(`DELETE FROM self_model_notes WHERE id IN (
        SELECT id FROM (
          SELECT n.id, ROW_NUMBER() OVER (PARTITION BY p.scope_key, p.conversation_json
            ORDER BY n.created_at DESC, n.id DESC) AS rank
          FROM self_model_notes n JOIN self_model_note_evidence e ON e.note_id = n.id
          JOIN self_model_note_provenance p ON p.note_id = n.id WHERE p.state = 'verified'
        ) WHERE rank > ?
      )`).run(boundedCount(keepVerified, 1000));
    })();
  } catch (err) { logger.warn({ err }, 'pruneSelfNotes failed'); }
}
