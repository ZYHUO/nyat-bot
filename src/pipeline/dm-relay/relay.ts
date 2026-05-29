// ────────────────────────────────────────
// DM Relay Orchestrator
// ────────────────────────────────────────

import type { FormattedMessage } from '../../shared/types.js';
import type { DmIntent } from './detector.js';
import { isPronounTarget } from './detector.js';
import { resolveGroup, savePendingGroupSelection, resolveGroupByHint, listUserGroups } from './group-resolver.js';
import { setDefaultGroup } from '../../tracking/user-profile.js';
import { checkFeatureGate } from './feature-gate.js';
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
import { getPendingRelayForSender, cancelRelay, enqueueRelay } from './relay-queue.js';
import { handleScheduleMessage, handleListScheduled, handleCancelScheduled } from './handlers/schedule.js';
import { handleNoteStart, handleNotePendingGroup, handleNoteStats, handleNoteGuess, handleNoteReveal } from './handlers/note.js';
import { handleSetProfile, handleSetProfileTags, handleViewProfile, handleListProfiles, handleProfileNotify } from './handlers/profile.js';
import { handleConfide, doConfide } from './handlers/confide.js';
import { handleFate } from './handlers/fate.js';

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

  const gate = await checkFeatureGate(group.chatId, 'view_group');
  if (gate) {
    await sender.sendDirect(dmChatId, gate, formatted.messageId);
    return;
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
  groupHint?: string,
  mode: 'immediate' | 'on_speak' | 'scheduled' = 'immediate',
  scheduledAt?: number,
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
    // 1a. Try group hint first (fuzzy title match)
    let hinted: ResolvedGroup | null = null;
    if (groupHint) {
      hinted = await resolveGroupByHint(formatted.uid, groupHint);
    }
    if (hinted) {
      group = hinted;
    } else {
      // 1b. Resolve group (default-group → single-group → multiple-prompt)
      const groupResult = await resolveGroup(formatted.uid);
      if (!groupResult.ok) {
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
  }

  const gate = await checkFeatureGate(group.chatId, 'relay');
  if (gate) {
    await sender.sendDirect(dmChatId, gate, formatted.messageId);
    return;
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

  // consent === 'approved'

  // 5. Deferred modes — enqueue instead of sending now
  if (mode === 'on_speak' || mode === 'scheduled') {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = mode === 'on_speak'
      ? now + 7 * 86400                       // on_speak: hold for 7 days
      : (scheduledAt ?? now) + 86400;         // scheduled: keep 1 day past fire time
    const id = enqueueRelay({
      sender_id: formatted.uid,
      target_id: target.uid,
      group_id: group.chatId,
      content,
      trigger_mode: mode,
      scheduled_at: mode === 'scheduled' ? (scheduledAt ?? null) : null,
      expires_at: expiresAt,
    });
    if (id < 0) {
      await sender.sendDirect(dmChatId, '你的待发送捎话太多了喵（上限10条），先处理一些再来~', formatted.messageId);
      return;
    }
    const targetName = target.username ? `@${target.username}` : target.fullName;
    if (mode === 'on_speak') {
      await sender.sendDirect(dmChatId, `📥 已存档喵~ 等 ${targetName} 下次在「${group.title}」发言，本喵就转告 TA（编号 #${id}，7天内有效）`, formatted.messageId);
    } else {
      const when = new Date((scheduledAt ?? now) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
      await sender.sendDirect(dmChatId, `⏰ 已安排在 ${when} 转告 ${targetName}（编号 #${id}）`, formatted.messageId);
    }
    logger.info({ senderUid: formatted.uid, targetUid: target.uid, groupChatId: group.chatId, mode, relayId: id }, 'Relay enqueued');
    return;
  }

  // 6. Immediate — send the relay now
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

/** Handle relay cancel — cancel a pending relay by ID */
async function handleRelayCancel(
  dmChatId: number,
  formatted: FormattedMessage,
  relayId: number,
): Promise<void> {
  const cancelled = cancelRelay(relayId, formatted.uid);
  if (cancelled) {
    await sender.sendDirect(dmChatId, `✅ 已取消捎话 #${relayId} 喵~`, formatted.messageId);
  } else {
    await sender.sendDirect(dmChatId, `找不到编号 #${relayId} 的待发送捎话喵~\n\n查看你的捎话：说"我的捎话"`, formatted.messageId);
  }
}

/** Handle relay list — show pending relays from sender */
async function handleRelayList(
  dmChatId: number,
  formatted: FormattedMessage,
): Promise<void> {
  const relays = getPendingRelayForSender(formatted.uid);
  if (relays.length === 0) {
    await sender.sendDirect(dmChatId, '你还没有待发送的捎话喵~\n\n发一个试试：\n"告诉张三 今晚开黑"', formatted.messageId);
    return;
  }

  const lines = relays.map((r, i) => {
    const mode = r.trigger_mode === 'immediate' ? '⚡立即' : r.trigger_mode === 'scheduled' ? '⏰定时' : '🗣等发言';
    const expires = new Date(r.expires_at * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `${i + 1}. #${r.id} | ${mode} → 目标${r.target_id}\n   「${r.content}」\n   过期：${expires}`;
  });

  await sender.sendDirect(
    dmChatId,
    `📨 你的待发送捎话：\n\n${lines.join('\n\n')}\n\n取消请说 "取消捎话 #编号"`,
    formatted.messageId,
  );
}

/** Handle "默认群 [序号]" — set the user's preferred default group */
async function handleSetDefaultGroup(
  dmChatId: number,
  formatted: FormattedMessage,
  groupIndex?: number,
): Promise<void> {
  const groups = await listUserGroups(formatted.uid);

  if (groups.length === 0) {
    await sender.sendDirect(dmChatId, '本喵还没在任何群里见过你喵~ 先在群里冒个泡吧！', formatted.messageId);
    return;
  }

  if (groups.length === 1) {
    setDefaultGroup(formatted.uid, groups[0]!.chatId);
    await sender.sendDirect(dmChatId, `你只在「${groups[0]!.title}」一个群，已设为默认啦喵~`, formatted.messageId);
    return;
  }

  // Index provided → set directly
  if (groupIndex !== undefined) {
    if (groupIndex < 1 || groupIndex > groups.length) {
      await sender.sendDirect(dmChatId, `序号超范围了喵~ 请在 1-${groups.length} 之间选~`, formatted.messageId);
      return;
    }
    const picked = groups[groupIndex - 1]!;
    setDefaultGroup(formatted.uid, picked.chatId);
    await sender.sendDirect(dmChatId, `✅ 已把「${picked.title}」设为默认群喵~ 以后私聊功能默认用这个群啦`, formatted.messageId);
    return;
  }

  // No index → list groups and wait for a number
  await savePendingGroupSelection(formatted.uid, { intent: 'set_default_group', groups });
  const list = groups.map((g, i) => `${i + 1}. ${g.title}`).join('\n');
  await sender.sendDirect(
    dmChatId,
    `想把哪个群设为默认喵？回复序号：\n${list}`,
    formatted.messageId,
  );
}

/** Main entry point for DM relay — dispatches based on intent */
export async function handleDmRelay(
  dmChatId: number,
  formatted: FormattedMessage,
  intent: DmIntent,
): Promise<void> {
  switch (intent.type) {
    case 'view_group':
      await handleViewGroup(dmChatId, formatted);
      break;
    case 'relay_message':
      await handleRelayMessage(dmChatId, formatted, intent.targetHandle, intent.content, undefined, intent.groupHint, intent.mode ?? 'immediate', intent.scheduledAt);
      break;
    case 'relay_cancel':
      await handleRelayCancel(dmChatId, formatted, intent.relayId);
      break;
    case 'relay_list':
      await handleRelayList(dmChatId, formatted);
      break;
    case 'schedule':
      await handleScheduleMessage(dmChatId, formatted, intent.content);
      break;
    case 'schedule_cancel':
      await handleCancelScheduled(dmChatId, formatted, intent.scheduleId);
      break;
    case 'my_schedules':
      await handleListScheduled(dmChatId, formatted);
      break;
    case 'note':
      await handleNoteStart(dmChatId, formatted, intent.content, intent.targetHandle);
      break;
    case 'note_stats':
      await handleNoteStats(dmChatId, formatted);
      break;
    case 'note_guess':
      await handleNoteGuess(dmChatId, formatted, intent.noteId, intent.guessedHandle);
      break;
    case 'note_reveal':
      await handleNoteReveal(dmChatId, formatted, intent.noteId);
      break;
    case 'set_profile':
      await handleSetProfile(dmChatId, formatted, intent.targetHandle, intent.notes);
      break;
    case 'set_profile_tags':
      await handleSetProfileTags(dmChatId, formatted, intent.targetHandle, intent.tags);
      break;
    case 'view_profile':
      await handleViewProfile(dmChatId, formatted, intent.targetHandle);
      break;
    case 'list_profiles':
      await handleListProfiles(dmChatId, formatted);
      break;
    case 'profile_notify':
      await handleProfileNotify(dmChatId, formatted, intent.targetHandle, intent.enabled);
      break;
    case 'fate':
      await handleFate({ uid: formatted.uid, chatId: dmChatId, messageId: formatted.messageId }, sender);
      break;
    case 'set_default_group':
      await handleSetDefaultGroup(dmChatId, formatted, intent.groupIndex);
      break;
    case 'confide': {
      const confideResult = await handleConfide(
        { uid: formatted.uid, chatId: dmChatId, messageId: formatted.messageId },
        sender,
        intent.content,
      );
      if (confideResult.pendingGroupSelection) {
        const result = await resolveGroup(formatted.uid);
        if (result.ok) {
          await doConfide(
            { uid: formatted.uid, chatId: dmChatId, messageId: formatted.messageId },
            sender,
            confideResult.pendingGroupSelection.content,
            result.group.chatId,
          );
        } else if (result.reason === 'multiple_groups') {
          await savePendingGroupSelection(formatted.uid, {
            intent: 'confide',
            groups: result.groups,
            content: confideResult.pendingGroupSelection.content,
          });
          await sender.sendDirect(dmChatId, result.reply, formatted.messageId);
        } else {
          await sender.sendDirect(dmChatId, result.reply, formatted.messageId);
        }
      }
      break;
    }
    case 'normal_chat':
      break; // not a DM feature — handled elsewhere
    default: {
      // Exhaustiveness guard: a new DmIntent without a case fails to compile here.
      const _exhaustive: never = intent;
      logger.warn({ intentType: (_exhaustive as DmIntent).type }, 'Unhandled DM intent type');
    }
  }
}

/** Handle pending group selection follow-up (user sent a number in DM) */
export async function handlePendingGroupSelection(
  dmChatId: number,
  formatted: FormattedMessage,
  selectedGroup: ResolvedGroup,
  intent: 'view_group' | 'relay_message' | 'note' | 'confide' | 'set_default_group',
  targetHandle?: string,
  content?: string,
): Promise<void> {
  switch (intent) {
    case 'view_group':
      await handleViewGroup(dmChatId, formatted, selectedGroup);
      break;
    case 'set_default_group':
      setDefaultGroup(formatted.uid, selectedGroup.chatId);
      await sender.sendDirect(dmChatId, `✅ 已把「${selectedGroup.title}」设为默认群喵~ 以后私聊功能默认用这个群啦`, formatted.messageId);
      break;
    case 'note':
      await handleNotePendingGroup(dmChatId, formatted, selectedGroup);
      break;
    case 'confide':
      await doConfide(
        { uid: formatted.uid, chatId: dmChatId, messageId: formatted.messageId },
        sender,
        content || '',
        selectedGroup.chatId,
      );
      break;
    default:
      if (targetHandle && content) {
        await handleRelayMessage(dmChatId, formatted, targetHandle, content, selectedGroup);
      }
  }
}
