// ────────────────────────────────────────
// 控制/偏好动作执行 — 由回复 LLM 在动作空间里输出(mute/unmute/remember/forget)
// ────────────────────────────────────────
//
// 取代旧的 L0 关键词 regex(闭嘴/别理我/记住/忘掉…):现在由回复模型结合上下文听懂
// 「别理我 / 别理 @某人 / 可以说话了 / 记住X / 忘掉X」,emit 结构化动作。
// 控制类(mute/unmute)**静默执行 + 一个 emoji reaction**(已读感),不发文字。
// 偏好类(remember/forget)同样静默 + reaction。

import { muteUser, unmuteUser, saveUserPreference, deleteUserPreference, setBotTag, clearBotTag } from '../tracking/user-profile.js';
import { applyMoodEvent } from '../tracking/mood.js';
import { getGroupMembers } from './context/manager.js';
import { reactToMessage } from '../bot/sender/telegram.js';
import { logger } from '../shared/logger.js';

export interface ControlAction {
  action: 'mute' | 'unmute' | 'remember' | 'forget' | 'call_me';
  /** mute/unmute 目标:'self'=发出者(默认)| 'user'=controlContent 指的那个人 */
  controlTarget?: 'self' | 'user';
  /** remember/forget 的内容,或 target='user' 时的 @用户名/名字,或 call_me 的新称呼(空=清掉) */
  controlContent?: string;
  /** mute 限时(分钟);省略=长期 */
  muteMinutes?: number;
}

const ACK_EMOJI: Record<string, string> = {
  mute: '👌', unmute: '👌', remember: '✍', forget: '👌', call_me: '✍',
};

/** @用户名/名字 → uid(群成员表里查;查不到返回 null) */
async function resolveTargetUid(chatId: number, ref: string): Promise<number | null> {
  const want = ref.replace(/^@/, '').toLowerCase().trim();
  if (!want) return null;
  try {
    const members = await getGroupMembers(chatId);
    const exact = members.find((m) => (m.username || '').toLowerCase() === want);
    if (exact) return exact.uid;
    const fuzzy = members.find(
      (m) => (m.fullName || '').toLowerCase().includes(want) || (m.username || '').toLowerCase().includes(want),
    );
    return fuzzy?.uid ?? null;
  } catch {
    return null;
  }
}

/**
 * 执行回复模型输出的控制/偏好动作。返回是否至少执行了一个(执行了即"已回应",
 * 投递层据此走静默路径,不再发文字)。
 */
export async function executeControlActions(
  actions: ControlAction[],
  chatId: number,
  requesterUid: number,
  ackMessageId: number,
): Promise<boolean> {
  if (actions.length === 0) return false;
  let executed = false;
  for (const a of actions) {
    try {
      if (a.action === 'mute' || a.action === 'unmute') {
        if (chatId >= 0) continue; // mute/unmute 仅群聊(DM 没意义)
        let uid = requesterUid;
        if (a.controlTarget === 'user' && a.controlContent) {
          const t = await resolveTargetUid(chatId, a.controlContent);
          if (t === null) {
            logger.info({ chatId, ref: a.controlContent }, 'mute target not found, skipping');
            continue;
          }
          uid = t;
        }
        if (a.action === 'mute') {
          const opts = a.muteMinutes ? { temporary: true, durationMs: a.muteMinutes * 60_000 } : undefined;
          muteUser(chatId, uid, a.muteMinutes ? 1 : 2, opts);
          applyMoodEvent(chatId, -10, 'mute_via_action');
        } else {
          unmuteUser(chatId, uid);
          applyMoodEvent(chatId, 5, 'unmute_via_action');
        }
      } else if (a.action === 'remember') {
        if (!a.controlContent) continue;
        saveUserPreference(chatId, requesterUid, a.controlContent);
      } else if (a.action === 'forget') {
        if (!a.controlContent) continue;
        deleteUserPreference(chatId, requesterUid, a.controlContent);
      } else if (a.action === 'call_me') {
        // 仅私聊生效(DM 里设的是跨群默认称呼)。有新称呼 → 设;空 → 清掉回退群里外号。
        if (chatId <= 0) continue;
        const tag = (a.controlContent ?? '').trim();
        if (tag) setBotTag(chatId, requesterUid, tag);
        else clearBotTag(chatId, requesterUid);
      } else {
        continue;
      }
      executed = true;
      // 已读感:给指令那条点个 emoji(best-effort,失败无所谓)
      reactToMessage(chatId, ackMessageId, ACK_EMOJI[a.action] ?? '👌').catch(() => {});
      logger.info({ chatId, action: a.action, target: a.controlTarget ?? 'self' }, 'Control action executed (silent)');
    } catch (err) {
      logger.debug({ err, action: a.action }, 'control action failed (non-critical)');
    }
  }
  return executed;
}
