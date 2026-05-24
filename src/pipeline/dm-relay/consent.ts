// ────────────────────────────────────────
// Consent Manager — target user opt-in for relay
// ────────────────────────────────────────

import { getDb } from '../../db/sqlite.js';
import { sendMessage } from '../../bot/sender/telegram.js';
import { logger } from '../../shared/logger.js';

export type ConsentStatus = 'approved' | 'denied' | 'pending';

const CONSENT_MARKER = '有人想通过bot给你带话';

/** Check current consent status for a target user in a group */
export function getConsent(groupChatId: number, targetUid: number): ConsentStatus | null {
  const row = getDb().prepare(`
    SELECT status FROM relay_consent
    WHERE group_chat_id = ? AND target_uid = ?
  `).get(groupChatId, targetUid) as { status: string } | undefined;

  if (!row) return null;
  return row.status as ConsentStatus;
}

/** Update consent status (UPSERT) */
export function setConsent(groupChatId: number, targetUid: number, status: ConsentStatus): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO relay_consent (group_chat_id, target_uid, status, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(group_chat_id, target_uid)
    DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
  `).run(groupChatId, targetUid, status, now);
}

/** Send consent request to group, asking target user to approve */
export async function requestConsent(
  groupChatId: number,
  targetUid: number,
  targetUsername: string,
  senderFullName: string,
): Promise<void> {
  // Set pending first
  setConsent(groupChatId, targetUid, 'pending');

  const mention = targetUsername ? `@${targetUsername}` : `uid:${targetUid}`;
  const text = `${mention} ${CONSENT_MARKER}（来自${senderFullName}），你同意吗？回复这条消息说「同意」或「不同意」即可~`;

  try {
    const msgId = await sendMessage(groupChatId, text);
    // Store the consent message ID for reference
    getDb().prepare(`
      UPDATE relay_consent SET consent_message_id = ?
      WHERE group_chat_id = ? AND target_uid = ?
    `).run(msgId, groupChatId, targetUid);
  } catch (err) {
    logger.error({ err, groupChatId, targetUid }, 'Failed to send consent request');
  }
}

/** Detect if a group message is a consent reply. Returns null if not a consent reply. */
export function detectConsentReply(
  textContent: string,
  replyToTextSnippet?: string,
): { approved: boolean } | null {
  // Must be replying to a message containing the consent marker
  if (!replyToTextSnippet || !replyToTextSnippet.includes(CONSENT_MARKER)) {
    return null;
  }

  const text = textContent.trim().toLowerCase();

  // Approval patterns
  if (/^(?:同意|好|可以|好的|行|ok|yes|允许|没问题|agreed?)$/i.test(text)) {
    return { approved: true };
  }

  // Denial patterns
  if (/^(?:不同意|不行|拒绝|不要|不可以|no|nope|refuse|不允许|算了)$/i.test(text)) {
    return { approved: false };
  }

  return null;
}
