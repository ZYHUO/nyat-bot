// ────────────────────────────────────────
// Target Resolver — find target user by @handle in a group
// ────────────────────────────────────────

import { getGroupMembers, getRecent } from '../context/manager.js';
import type { GroupMember } from '../context/manager.js';
import { slimContextForAI } from '../context/slim.js';
import { callWithFallback } from '../../ai/fallback.js';
import { logger } from '../../shared/logger.js';
import type { FormattedMessage } from '../../shared/types.js';

export interface ResolvedTarget {
  uid: number;
  username: string;
  fullName: string;
}

export async function resolveTarget(
  groupChatId: number,
  handle: string,
): Promise<ResolvedTarget | null> {
  const members = await getGroupMembers(groupChatId);
  const lowerHandle = handle.toLowerCase();

  // Exact username match (case-insensitive)
  const exactMatch = members.find(
    (m) => m.username && m.username.toLowerCase() === lowerHandle,
  );
  if (exactMatch) return toTarget(exactMatch);

  // Fallback: fullName substring match
  const nameMatch = members.find(
    (m) => m.fullName && m.fullName.toLowerCase().includes(lowerHandle),
  );
  if (nameMatch) return toTarget(nameMatch);

  return null;
}

/** Resolve a pronoun (他/她/TA) to a concrete target via AI + recent group context */
export async function resolveTargetByPronoun(
  groupChatId: number,
  pronoun: string,
  senderUid: number,
  relayContent: string,
  dmContext: FormattedMessage,
): Promise<ResolvedTarget | null> {
  // Fetch recent group context and member list
  const [recent, members] = await Promise.all([
    getRecent(groupChatId, 20),
    getGroupMembers(groupChatId),
  ]);

  if (members.length === 0) return null;

  // Also get recent DM context (private chat between user and bot)
  const dmRecent = await getRecent(senderUid, 10);

  const groupContextStr = recent.length > 0
    ? slimContextForAI(recent, dmContext, 0)
    : '(无最近群消息)';

  const dmContextStr = dmRecent.length > 0
    ? slimContextForAI(dmRecent, dmContext, 0)
    : '(无最近私聊记录)';

  const memberList = members
    .filter((m) => m.uid !== senderUid) // exclude sender
    .slice(0, 30) // limit
    .map((m) => `${m.fullName}${m.username ? '(@' + m.username + ')' : ''} [uid:${m.uid}]`)
    .join('\n');

  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        {
          role: 'system',
          content: `用户在私聊中说了一句话，其中"${pronoun}"指代群里的某个人。根据最近的群聊记录和私聊上下文，判断"${pronoun}"最可能指谁。

仅输出JSON: {"uid": 数字, "confidence": 0.0-1.0}
如果无法确定，输出: {"uid": null, "confidence": 0}`,
        },
        {
          role: 'user',
          content: `用户说：「${relayContent}」（想转达给"${pronoun}"）

最近的群聊记录：
${groupContextStr}

最近的私聊记录：
${dmContextStr}

群成员列表：
${memberList}`,
        },
      ],
      maxTokens: 50,
      temperature: 0,
    });

    const cleaned = result.content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned) as { uid?: number | null; confidence?: number };

    if (parsed.uid && (parsed.confidence ?? 0) >= 0.5) {
      const member = members.find((m) => m.uid === parsed.uid);
      if (member) {
        logger.info({
          pronoun,
          resolvedUid: parsed.uid,
          resolvedName: member.fullName,
          confidence: parsed.confidence,
        }, 'Pronoun resolved via AI');
        return toTarget(member);
      }
    }

    logger.info({ pronoun, parsed }, 'Pronoun resolution: low confidence or no match');
  } catch (err) {
    logger.warn({ err, pronoun }, 'Pronoun resolution AI call failed');
  }

  return null;
}

function toTarget(m: GroupMember): ResolvedTarget {
  return { uid: m.uid, username: m.username, fullName: m.fullName };
}
