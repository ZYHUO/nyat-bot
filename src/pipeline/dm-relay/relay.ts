// ────────────────────────────────────────
// DM Relay Orchestrator
// ────────────────────────────────────────

import type { FormattedMessage } from '../../shared/types.js';
import type { DmIntent } from './detector.js';
import { isPronounTarget } from './detector.js';
import { resolveGroup, savePendingGroupSelection } from './group-resolver.js';
import type { ResolvedGroup } from './group-resolver.js';
import { resolveTarget, resolveTargetByPronoun } from './target-resolver.js';
import { runSafetyChecks } from './safety.js';
import { getConsent, requestConsent } from './consent.js';
import { getRecent } from '../context/manager.js';
import { slimContextForAI } from '../context/slim.js';
import { callWithFallback } from '../../ai/fallback.js';
import { sendMessage, sendChatAction } from '../../bot/sender/telegram.js';
import { StreamingSender } from '../../bot/sender/streaming.js';
import { getDb } from '../../db/sqlite.js';
import { isMaster } from '../../admin/auth.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';

const sender = new StreamingSender();

/** Record a relay in the log table */
function recordRelay(
  senderUid: number,
  targetUid: number,
  groupChatId: number,
  content: string,
  sentMessageId?: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    INSERT INTO relay_log (sender_uid, target_uid, group_chat_id, content, sent_message_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(senderUid, targetUid, groupChatId, content, sentMessageId ?? null, now);
}

/** Handle "看群消息" — summarize recent group context */
async function handleViewGroup(
  dmChatId: number,
  formatted: FormattedMessage,
  preResolvedGroup?: ResolvedGroup,
): Promise<void> {
  await sendChatAction(dmChatId, 'typing');

  let group: ResolvedGroup;

  if (preResolvedGroup) {
    group = preResolvedGroup;
  } else {
    const result = await resolveGroup(formatted.uid);

    if (!result.ok) {
      // Save pending state for group number follow-up
      if (result.reason === 'multiple_groups') {
        await savePendingGroupSelection(formatted.uid, {
          intent: 'view_group',
          groups: result.groups,
        });
      }
      await sender.sendDirect(dmChatId, result.reply, formatted.messageId);
      return;
    }
    group = result.group;
  }

  // Fetch recent group context
  const recent = await getRecent(group.chatId, 30);
  if (recent.length === 0) {
    await sender.sendDirect(dmChatId, '群里最近没什么消息喵~', formatted.messageId);
    return;
  }

  // Format context for AI
  const contextStr = slimContextForAI(recent, formatted, 0);

  try {
    const aiResult = await callWithFallback({
      usage: 'summarize',
      messages: [
        {
          role: 'system',
          content: '用中文简要概括以下群聊记录的主要话题和讨论内容。保持简洁（3-5句话），用自然口语风格。',
        },
        {
          role: 'user',
          content: `群「${group.title}」的最近消息：\n${contextStr}`,
        },
      ],
      maxTokens: 200,
      temperature: 0.3,
    });

    await sender.sendDirect(dmChatId, `群「${group.title}」最近在聊：\n\n${aiResult.content}`, formatted.messageId);
  } catch (err) {
    logger.error({ err, groupChatId: group.chatId }, 'View group AI summarization failed');
    await sender.sendDirect(dmChatId, '摘要生成失败了喵，稍后再试试~', formatted.messageId);
  }
}

/** Infer relay content from recent DM context when user says "发给他" without explicit content */
async function inferContentFromDm(
  dmChatId: number,
  formatted: FormattedMessage,
): Promise<string | null> {
  const dmRecent = await getRecent(dmChatId, 10);
  if (dmRecent.length === 0) return null;

  const contextStr = slimContextForAI(dmRecent, formatted, 0);

  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        {
          role: 'system',
          content: '用户在私聊中说"发给他"或类似的话，但没有明确说要发什么内容。根据最近的私聊记录，推断用户想要转发的具体内容。\n\n仅输出JSON: {"content": "推断出的内容", "confidence": 0.0-1.0}\n如果无法确定，输出: {"content": null, "confidence": 0}',
        },
        {
          role: 'user',
          content: `用户当前说了：「${formatted.textContent}」\n\n最近的私聊记录：\n${contextStr}`,
        },
      ],
      maxTokens: 100,
      temperature: 0,
    });

    const cleaned = result.content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned) as { content?: string | null; confidence?: number };

    if (parsed.content && (parsed.confidence ?? 0) >= 0.5) {
      return parsed.content;
    }
  } catch (err) {
    logger.warn({ err }, 'Content inference from DM context failed');
  }

  return null;
}

/** Handle "@someone message" — relay message to group */
async function handleRelayMessage(
  dmChatId: number,
  formatted: FormattedMessage,
  targetHandle: string,
  content: string,
  preResolvedGroup?: ResolvedGroup,
): Promise<void> {
  await sendChatAction(dmChatId, 'typing');

  // 0. If content needs inference from DM context
  if (content === '__infer_from_context__') {
    const inferred = await inferContentFromDm(dmChatId, formatted);
    if (!inferred) {
      await sender.sendDirect(dmChatId, '你想发什么内容喵？告诉本喵具体要说的话~', formatted.messageId);
      return;
    }
    content = inferred;
  }

  let group: ResolvedGroup;

  if (preResolvedGroup) {
    group = preResolvedGroup;
  } else {
    // 1. Resolve group
    const groupResult = await resolveGroup(formatted.uid);
    if (!groupResult.ok) {
      // Save pending state for group number follow-up
      if (groupResult.reason === 'multiple_groups') {
        await savePendingGroupSelection(formatted.uid, {
          intent: 'relay_message',
          groups: groupResult.groups,
          targetHandle,
          content,
        });
      }
      await sender.sendDirect(dmChatId, groupResult.reply, formatted.messageId);
      return;
    }
    group = groupResult.group;
  }

  // 2. Resolve target user
  let target;
  if (isPronounTarget(targetHandle)) {
    // AI-based pronoun resolution
    target = await resolveTargetByPronoun(
      group.chatId,
      targetHandle,
      formatted.uid,
      content,
      formatted,
    );
    if (!target) {
      await sender.sendDirect(
        dmChatId,
        `本喵猜不出"${targetHandle}"是谁喵~ 试试直接说名字或者 @用户名？`,
        formatted.messageId,
      );
      return;
    }
  } else {
    target = await resolveTarget(group.chatId, targetHandle);
    if (!target) {
      await sender.sendDirect(
        dmChatId,
        `在群「${group.title}」里找不到 @${targetHandle} 喵~`,
        formatted.messageId,
      );
      return;
    }
  }

  // 3. Safety checks
  const safety = await runSafetyChecks(formatted.uid, group.chatId, target.uid, content);
  if (!safety.ok) {
    await sender.sendDirect(dmChatId, safety.reply, formatted.messageId);
    return;
  }

  // 4. Consent check (master is exempt)
  const masterExempt = isMaster(formatted.uid, env().MASTER_UID);
  const consent = masterExempt ? 'approved' : getConsent(group.chatId, target.uid);

  if (consent === 'denied') {
    await sender.sendDirect(dmChatId, `${target.fullName} 不接受通过bot转发的消息喵~`, formatted.messageId);
    return;
  }

  if (consent === 'pending') {
    await sender.sendDirect(dmChatId, `还在等 ${target.fullName} 同意中喵，稍后再试~`, formatted.messageId);
    return;
  }

  if (consent === null) {
    // No consent record — request it
    await requestConsent(group.chatId, target.uid, target.username, formatted.fullName);
    await sender.sendDirect(
      dmChatId,
      `本喵已经在群里问 ${target.fullName} 了，等 TA 同意后你再发一次就行喵~`,
      formatted.messageId,
    );
    return;
  }

  // consent === 'approved' — send the relay
  const mention = target.username ? `@${target.username}` : target.fullName;
  const relayText = `${mention} ${formatted.fullName}想对你说：${content}`;

  try {
    const msgId = await sendMessage(group.chatId, relayText);
    recordRelay(formatted.uid, target.uid, group.chatId, content, msgId);
    await sender.sendDirect(dmChatId, '已经帮你发到群里了喵~', formatted.messageId);

    logger.info({
      senderUid: formatted.uid,
      targetUid: target.uid,
      groupChatId: group.chatId,
      sentMessageId: msgId,
    }, 'Relay message sent');
  } catch (err) {
    logger.error({ err, groupChatId: group.chatId }, 'Failed to send relay message');
    await sender.sendDirect(dmChatId, '发送失败了喵，稍后再试试~', formatted.messageId);
  }
}

/** Main entry point for DM relay — dispatches based on intent */
export async function handleDmRelay(
  dmChatId: number,
  formatted: FormattedMessage,
  intent: DmIntent & { type: 'view_group' | 'relay_message' },
): Promise<void> {
  if (intent.type === 'view_group') {
    await handleViewGroup(dmChatId, formatted);
  } else {
    await handleRelayMessage(dmChatId, formatted, intent.targetHandle, intent.content);
  }
}

/** Handle pending group selection follow-up (user sent a number in DM) */
export async function handlePendingGroupSelection(
  dmChatId: number,
  formatted: FormattedMessage,
  selectedGroup: ResolvedGroup,
  intent: 'view_group' | 'relay_message',
  targetHandle?: string,
  content?: string,
): Promise<void> {
  if (intent === 'view_group') {
    await handleViewGroup(dmChatId, formatted, selectedGroup);
  } else if (targetHandle && content) {
    await handleRelayMessage(dmChatId, formatted, targetHandle, content, selectedGroup);
  }
}
