// ────────────────────────────────────────
// DM Intent Detector — regex fast path + AI fallback
// ────────────────────────────────────────

import { callWithFallback } from '../../ai/fallback.js';
import { logger } from '../../shared/logger.js';
import { parseScheduleTime } from './handlers/schedule.js';

export type DmIntent =
  | { type: 'normal_chat' }
  | { type: 'view_group'; groupHint?: string }
  | { type: 'relay_message'; targetHandle: string; content: string; groupHint?: string; mode?: 'immediate' | 'on_speak' | 'scheduled'; scheduledAt?: number }
  | { type: 'relay_cancel'; relayId: number }
  | { type: 'relay_list' }
  | { type: 'schedule'; content: string }
  | { type: 'schedule_cancel'; scheduleId: number }
  | { type: 'my_schedules' }
  | { type: 'note'; content?: string; targetHandle?: string }
  | { type: 'note_stats' }
  | { type: 'note_guess'; noteId: number; guessedHandle: string }
  | { type: 'note_reveal'; noteId: number }
  | { type: 'set_profile'; targetHandle: string; notes: string }
  | { type: 'set_profile_tags'; targetHandle: string; tags: string }
  | { type: 'view_profile'; targetHandle: string }
  | { type: 'list_profiles' }
  | { type: 'profile_notify'; targetHandle: string; enabled: boolean }
  | { type: 'confide'; content?: string }
  | { type: 'set_default_group'; groupIndex?: number }
  | { type: 'fate' };

const VIEW_GROUP_PATTERN = /(?:帮我?)?(?:看看?|查看|瞅瞅|看下|瞄一眼)群|群里?(?:在聊什么|最近|消息|动态|有什么|聊了什么|怎么样|在说什么|说了什么)|群聊?(?:记录|消息|内容)/i;

// ── New intent patterns ──
const RELAY_CANCEL_PATTERN = /^(?:取消|撤回|撤销)(?:捎话|传话|relay)\s*#?(\d+)/i;
const RELAY_LIST_PATTERN = /^(?:我的|查看|看看)(?:捎话|传话|relay)(?:列表|记录)?|(?:捎话|传话)(?:列表|记录)/i;
const SCHEDULE_PATTERN = /^(?:(?:帮我)?(?:设[置定]|提醒|预约|定时)|(?:明天|后天|每天|每周|今天|\d+\s*(?:分钟|小时)后))/i;
const SCHEDULE_CANCEL_PATTERN = /^(?:取消|撤回|删除)(?:提醒|定时|预约)\s*#?(\d+)/i;
const MY_SCHEDULES_PATTERN = /^(?:我的|查看|看看)(?:提醒|定时|预约|schedule)(?:列表|记录)?|(?:提醒|定时)(?:列表|记录)/i;

// Note patterns
const NOTE_PATTERN = /^(?:纸条|小纸条|匿名|note)/i;
const NOTE_STATS_PATTERN = /^(?:纸条统计|纸条记录|我的纸条|纸条用量|note\s*stats)/i;
// Guess: 猜纸条 #N @X / 猜纸条5 张三
const NOTE_GUESS_PATTERN = /^猜(?:一下)?纸条\s*#?(\d+)\s+@?(\S+)/i;
// Reveal: 公布纸条 #N / 揭晓纸条5
const NOTE_REVEAL_PATTERN = /^(?:公布|揭晓|揭秘|公开)纸条\s*#?(\d+)/i;

// Confide patterns
const CONFIDE_PATTERN = /^(?:树洞|说个秘密|倾诉|confide)/i;

// Fate patterns
const FATE_PATTERN = /^(?:缘分签|抽签|今日运势|fate)/i;

// Profile patterns
const SET_PROFILE_PATTERN = /^(?:给|帮|替)(.+?)(?:记[一下下]?|写[一下下]?|备注|profile)\s+(.+)/i;
// Tag: 给X打标签 a,b / 给X加标签 a b
const TAG_PATTERN = /^(?:给|帮|替)(.+?)(?:打|加|贴|设)?标签[\s，,：:]+(.+)/i;
const VIEW_PROFILE_PATTERN = /^(?:查看|看看|查[一下下]?)(.+?)(?:的)?(?:档案|备注|profile|小档案)/i;
const LIST_PROFILES_PATTERN = /^(?:我的|查看|看看)(?:档案|备注|profile|小档案)(?:列表|记录)?|(?:档案|小档案)(?:列表|记录)/i;
const PROFILE_NOTIFY_PATTERN = /^(?:(?:打开|开启|关闭|取消)(.+?)(?:的)?(?:提醒|通知))|(?:(?:提醒|通知)(?:我)?(.+?)(?:说话|发言))/i;

// Default group: 默认群 / 设为默认群 / 设置默认群 [序号]
const SET_DEFAULT_PATTERN = /^(?:设(?:为|置)?)?默认群\s*(\d+)?$/i;

// On-speak relay: 等X上线告诉他 内容 / 下次X说话时跟他说 内容
const ON_SPEAK_RELAY_PATTERN = /^(?:等|等到|下次|当)?\s*(\S+?)(?:上线|出现|冒泡|说话|发言|来了|在线|出没)(?:的?时候|时|了|后)?[\s，,]*(?:再|就)?(?:帮我?)?(?:告诉|跟|对|给|转告|让|叫)(?:(?:他|她|ta|TA|Ta|它|对方)(?:们)?)?(?:说|讲|带句?话|传句?话)?[\s，,：:]*([\s\S]+)/;

// Scheduled relay: 明天9点告诉X 内容 (time prefix + relay verb + target + content)
const SCHEDULED_RELAY_PATTERN = /^((?:明天|后天|大后天|今天|每天|每周[一二三四五六日天]|\d+\s*(?:分钟|小时|天)后|(?:上午|下午|晚上|早上|凌晨|中午)?\d{1,2}[点时](?:\d{1,2}分?)?(?:半)?)[\s\S]*?)(?:帮我?)?(?:告诉|跟|对|给|转告)(@?[^\s，,：:说]+?)(?:说|讲|：|:|，|,|\s)+([\s\S]+)/;

// @handle message
const AT_RELAY_PATTERN = /^@(\S+)\s+([\s\S]+)/;

// Pronouns that need AI resolution
const PRONOUN_SET = new Set(['他', '她', 'ta', 'TA', 'Ta', '它', '那个人', '那位', '对方']);

// Feature keyword gate: only call AI intent detection if text contains these
// This avoids an expensive AI call for obvious casual chat like "hi", "你好", "哈哈"
const DM_FEATURE_KEYWORDS = /(?:传话|带话|转告|捎话|告诉|发给|转达|纸条|小纸条|匿名|树洞|倾诉|秘密|缘分签|抽签|运势|档案|备注|提醒|通知|发言|说话|定时|预约|取消|撤回|查看|看看|群里|群聊|在聊|记录)/;

// ── Quick regex patterns (0ms, tried first) ──

// Pronoun: 告诉他/她/TA + content
const PRONOUN_RELAY_PATTERN = /^(?:那(?:你)?|你)?(?:帮我?)?(?:告诉|跟|和|对|给|转告|转达(?:给)?)(他|她|ta|TA|Ta|它|那个人|那位|对方)(?:说|讲|带(?:个|句)?话|传(?:个|句)?话)?(?:一声|一下)?[\s，,：:]*([\s\S]+)/;

// Named with verb: 告诉Alice说xxx
const NAMED_VERB_RELAY_PATTERN = /^(?:那(?:你)?|你)?(?:帮我?)?(?:告诉|跟|和|对|给|转告|转达(?:给)?)(@?\S+?)(?:说|讲|带(?:个|句)?话|传(?:个|句)?话|转达)[\s，,：:]*([\s\S]+)/;

// Named with space: 告诉Alice xxx
const NAMED_SPACE_RELAY_PATTERN = /^(?:那(?:你)?|你)?(?:帮我?)?(?:告诉|跟|和|对|给|转告|转达(?:给)?)(@?\S+?)\s+([\s\S]+)/;

// Send-to pronoun: 发给他 content
const SEND_PRONOUN_RELAY_PATTERN = /(?:发给|传话给|带话给|转发给|传给|送给)(他|她|ta|TA|Ta|它|那个人|那位|对方)[\s，,：:]*([\s\S]*)/;

// Send-to named: 传话给Alice content
const SEND_NAMED_RELAY_PATTERN = /(?:帮我?)?(?:发给|传话给|带话给|转发给|传给|送给)(@?\S+?)\s+([\s\S]+)/;

/** Fast regex-only detection (no AI cost) */
function detectByRegex(trimmed: string, botUsername: string): DmIntent | null {
  // Default group: 默认群 [序号]
  const setDefault = trimmed.match(SET_DEFAULT_PATTERN);
  if (setDefault) {
    const idx = setDefault[1] ? parseInt(setDefault[1], 10) : undefined;
    return { type: 'set_default_group', groupIndex: idx };
  }

  // New intents: schedule cancel
  const schedCancel = trimmed.match(SCHEDULE_CANCEL_PATTERN);
  if (schedCancel) {
    return { type: 'schedule_cancel', scheduleId: parseInt(schedCancel[1]!, 10) };
  }

  // New intents: relay cancel
  const relayCancel = trimmed.match(RELAY_CANCEL_PATTERN);
  if (relayCancel) {
    return { type: 'relay_cancel', relayId: parseInt(relayCancel[1]!, 10) };
  }

  // New intents: my schedules list
  if (MY_SCHEDULES_PATTERN.test(trimmed)) {
    return { type: 'my_schedules' };
  }

  // New intents: relay list
  if (RELAY_LIST_PATTERN.test(trimmed)) {
    return { type: 'relay_list' };
  }

  // Scheduled relay: 明天9点告诉张三 内容 (must precede plain schedule)
  const schedRelay = trimmed.match(SCHEDULED_RELAY_PATTERN);
  if (schedRelay) {
    const timeExpr = schedRelay[1]!.trim();
    const target = schedRelay[2]!.replace(/^@/, '').trim();
    const content = schedRelay[3]!.trim();
    if (target && target.toLowerCase() !== botUsername.toLowerCase() && content) {
      // Reuse parseScheduleTime to compute the absolute fire time
      const parsed = parseScheduleTime(`${timeExpr} ${content}`);
      if (parsed) {
        return {
          type: 'relay_message',
          targetHandle: target,
          content: parsed.content,
          mode: 'scheduled',
          scheduledAt: parsed.nextRunAt,
        };
      }
    }
  }

  // On-speak relay: 等张三上线告诉他 内容
  const onSpeak = trimmed.match(ON_SPEAK_RELAY_PATTERN);
  if (onSpeak) {
    const target = onSpeak[1]!.replace(/^@/, '').trim();
    const content = onSpeak[2]!.trim();
    if (target && target.toLowerCase() !== botUsername.toLowerCase() && content) {
      return { type: 'relay_message', targetHandle: target, content, mode: 'on_speak' };
    }
  }

  // New intents: schedule (time-based)
  if (SCHEDULE_PATTERN.test(trimmed)) {
    return { type: 'schedule', content: trimmed };
  }

  // Profile notify: 开启/关闭xxx提醒
  const notifyMatch = trimmed.match(PROFILE_NOTIFY_PATTERN);
  if (notifyMatch) {
    const handle = (notifyMatch[1] || notifyMatch[2] || '').trim();
    const enabled = /^(?:打开|开启|提醒|通知)/.test(trimmed);
    if (handle) return { type: 'profile_notify', targetHandle: handle, enabled };
  }

  // List profiles: 我的小档案
  if (LIST_PROFILES_PATTERN.test(trimmed)) {
    return { type: 'list_profiles' };
  }

  // View profile: 看看xxx的档案
  const viewProf = trimmed.match(VIEW_PROFILE_PATTERN);
  if (viewProf) {
    return { type: 'view_profile', targetHandle: viewProf[1]!.trim() };
  }

  // Set profile tags: 给xxx打标签 a,b
  const tagMatch = trimmed.match(TAG_PATTERN);
  if (tagMatch) {
    return { type: 'set_profile_tags', targetHandle: tagMatch[1]!.trim(), tags: tagMatch[2]!.trim() };
  }

  // Set profile: 给xxx记一下xxx
  const setProf = trimmed.match(SET_PROFILE_PATTERN);
  if (setProf) {
    return { type: 'set_profile', targetHandle: setProf[1]!.trim(), notes: setProf[2]!.trim() };
  }

  // Note stats: 纸条统计
  if (NOTE_STATS_PATTERN.test(trimmed)) {
    return { type: 'note_stats' };
  }

  // Note guess: 猜纸条 #N @X
  const noteGuess = trimmed.match(NOTE_GUESS_PATTERN);
  if (noteGuess) {
    return { type: 'note_guess', noteId: parseInt(noteGuess[1]!, 10), guessedHandle: noteGuess[2]!.replace(/^@/, '').trim() };
  }

  // Note reveal: 公布纸条 #N
  const noteReveal = trimmed.match(NOTE_REVEAL_PATTERN);
  if (noteReveal) {
    return { type: 'note_reveal', noteId: parseInt(noteReveal[1]!, 10) };
  }

  // Note: 纸条
  if (NOTE_PATTERN.test(trimmed)) {
    return { type: 'note', content: trimmed };
  }

  // Fate: 缘分签
  if (FATE_PATTERN.test(trimmed)) {
    return { type: 'fate' };
  }

  // Confide: 树洞
  if (CONFIDE_PATTERN.test(trimmed)) {
    const content = trimmed.replace(CONFIDE_PATTERN, '').trim();
    return { type: 'confide', content: content || undefined };
  }

  // @handle relay
  const atMatch = trimmed.match(AT_RELAY_PATTERN);
  if (atMatch) {
    const handle = atMatch[1]!;
    const content = atMatch[2]!.trim();
    if (handle.toLowerCase() !== botUsername.toLowerCase() && content) {
      return { type: 'relay_message', targetHandle: handle, content };
    }
  }

  // Pronoun: 告诉他 xxx
  const pm = trimmed.match(PRONOUN_RELAY_PATTERN);
  if (pm && pm[2]!.trim()) {
    return { type: 'relay_message', targetHandle: pm[1]!, content: pm[2]!.trim() };
  }

  // Named with verb: 告诉Alice说xxx
  const nvm = trimmed.match(NAMED_VERB_RELAY_PATTERN);
  if (nvm) {
    const t = nvm[1]!.replace(/^@/, '');
    if (t.toLowerCase() !== botUsername.toLowerCase() && t && nvm[2]!.trim()) {
      return { type: 'relay_message', targetHandle: t, content: nvm[2]!.trim() };
    }
  }

  // Named with space: 告诉Alice xxx
  const nsm = trimmed.match(NAMED_SPACE_RELAY_PATTERN);
  if (nsm) {
    const t = nsm[1]!.replace(/^@/, '');
    if (t.toLowerCase() !== botUsername.toLowerCase() && t && nsm[2]!.trim()) {
      return { type: 'relay_message', targetHandle: t, content: nsm[2]!.trim() };
    }
  }

  // Send-to pronoun: 发给他
  const spm = trimmed.match(SEND_PRONOUN_RELAY_PATTERN);
  if (spm) {
    const content = (spm[2] || '').trim();
    return { type: 'relay_message', targetHandle: spm[1]!, content: content || '__infer_from_context__' };
  }

  // Send-to named: 传话给Alice xxx
  const snm = trimmed.match(SEND_NAMED_RELAY_PATTERN);
  if (snm) {
    const t = snm[1]!.replace(/^@/, '');
    if (t.toLowerCase() !== botUsername.toLowerCase() && t && snm[2]!.trim()) {
      return { type: 'relay_message', targetHandle: t, content: snm[2]!.trim() };
    }
  }

  return null; // no regex match
}

/** AI-based intent detection — catches natural language for all DM features */
async function detectByAI(text: string): Promise<DmIntent> {
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        {
          role: 'system',
          content: `判断用户私聊消息的意图。可能的意图：

1. relay_message — 传话、带话、发消息给群里某人
   → {"type": "relay_message", "target": "人名", "content": "内容", "group_hint": null, "mode": "immediate", "scheduled_at": null}
   - mode=on_speak：用户想"等他上线/出现/说话时再转告"（如"等张三上线告诉他X"）
   - mode=scheduled：用户指定具体时间转告（如"明天9点告诉张三X"），scheduled_at 填 ISO 时间
   - 其余情况 mode=immediate
2. view_group — 看群里在聊什么
   → {"type": "view_group"}
3. note — 匿名纸条、小纸条，想匿名给某人留言
   → {"type": "note", "content": "纸条内容", "target": "目标人名或null"}
4. confide — 树洞、倾诉、说秘密，想匿名分享心事到群里
   → {"type": "confide", "content": "倾诉内容或null"}
5. fate — 缘分签、抽签、看运势
   → {"type": "fate"}
6. schedule — 定时提醒、预约提醒
   → {"type": "schedule", "content": "提醒内容和时间"}
7. set_profile — 给某人写备注/档案
   → {"type": "set_profile", "target": "人名", "notes": "备注内容"}
7b. set_profile_tags — 给某人打标签/加标签
   → {"type": "set_profile_tags", "target": "人名", "tags": "标签1,标签2"}
8. view_profile — 查看某人的档案/备注
   → {"type": "view_profile", "target": "人名"}
9. list_profiles — 查看我的档案列表
   → {"type": "list_profiles"}
10. profile_notify — 开启/关闭某人发言提醒（提醒我他/她说话）
    → {"type": "profile_notify", "target": "人名", "enabled": true|false}
11. relay_list — 查看我未送达的捎话列表（"我的捎话"、"看下我的传话"）
    → {"type": "relay_list"}
12. relay_cancel — 取消编号N的捎话（"取消捎话5"、"撤回传话 #3"）
    → {"type": "relay_cancel", "relay_id": 数字}
13. my_schedules — 查看我设的定时提醒列表（"我的提醒"、"看下我的定时"）
    → {"type": "my_schedules"}
14. schedule_cancel — 取消编号N的定时提醒（"取消提醒5"、"删除定时 #3"）
    → {"type": "schedule_cancel", "schedule_id": 数字}
15. note_stats — 查看纸条统计（"纸条统计"、"我的纸条用量"）
    → {"type": "note_stats"}
16. normal_chat — 普通聊天，和以上功能无关
    → {"type": "normal_chat"}

注意：
- target 可以是具体名字、@username、或代词（他/她）
- content 如果用户没明确说，设为 null
- profile_notify 的 enabled：开启/打开=true，关闭/取消=false
- relay_cancel/schedule_cancel 必须从原文里识别一个数字编号
- 只输出JSON，不要多余文字`,
        },
        { role: 'user', content: text },
      ],
      maxTokens: 150,
      temperature: 0,
    });

    const cleaned = result.content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned) as {
      type?: string;
      target?: string;
      content?: string | null;
      notes?: string | null;
      tags?: string | null;
      group_hint?: string | null;
      enabled?: boolean;
      relay_id?: number;
      schedule_id?: number;
      mode?: string;
      scheduled_at?: string | null;
    };

    if (parsed.type === 'relay_message' && parsed.target) {
      const mode = parsed.mode === 'on_speak' || parsed.mode === 'scheduled' ? parsed.mode : 'immediate';
      let scheduledAt: number | undefined;
      if (mode === 'scheduled' && parsed.scheduled_at) {
        const ts = Date.parse(parsed.scheduled_at);
        if (!isNaN(ts)) scheduledAt = Math.floor(ts / 1000);
      }
      // scheduled mode requires a valid future time; otherwise fall back to immediate
      const effectiveMode = mode === 'scheduled' && !scheduledAt ? 'immediate' : mode;
      return {
        type: 'relay_message',
        targetHandle: parsed.target,
        content: parsed.content || '__infer_from_context__',
        groupHint: parsed.group_hint || undefined,
        mode: effectiveMode,
        ...(scheduledAt ? { scheduledAt } : {}),
      };
    }

    if (parsed.type === 'view_group') {
      return { type: 'view_group' };
    }

    if (parsed.type === 'note') {
      return {
        type: 'note',
        content: parsed.content || undefined,
        targetHandle: parsed.target || undefined,
      };
    }

    if (parsed.type === 'confide') {
      return { type: 'confide', content: parsed.content || undefined };
    }

    if (parsed.type === 'fate') {
      return { type: 'fate' };
    }

    if (parsed.type === 'schedule' && parsed.content) {
      return { type: 'schedule', content: parsed.content };
    }

    if (parsed.type === 'set_profile' && parsed.target && parsed.notes) {
      return { type: 'set_profile', targetHandle: parsed.target, notes: parsed.notes };
    }

    if (parsed.type === 'set_profile_tags' && parsed.target && parsed.tags) {
      return { type: 'set_profile_tags', targetHandle: parsed.target, tags: parsed.tags };
    }

    if (parsed.type === 'view_profile' && parsed.target) {
      return { type: 'view_profile', targetHandle: parsed.target };
    }

    if (parsed.type === 'list_profiles') {
      return { type: 'list_profiles' };
    }

    if (parsed.type === 'profile_notify' && parsed.target) {
      return {
        type: 'profile_notify',
        targetHandle: parsed.target,
        enabled: parsed.enabled !== false,
      };
    }

    if (parsed.type === 'relay_list') {
      return { type: 'relay_list' };
    }

    if (parsed.type === 'relay_cancel' && typeof parsed.relay_id === 'number') {
      return { type: 'relay_cancel', relayId: parsed.relay_id };
    }

    if (parsed.type === 'my_schedules') {
      return { type: 'my_schedules' };
    }

    if (parsed.type === 'schedule_cancel' && typeof parsed.schedule_id === 'number') {
      return { type: 'schedule_cancel', scheduleId: parsed.schedule_id };
    }

    if (parsed.type === 'note_stats') {
      return { type: 'note_stats' };
    }
  } catch (err) {
    logger.warn({ err }, 'AI intent detection failed, falling back to normal_chat');
  }

  return { type: 'normal_chat' };
}

/** Main detection: regex fast path → AI fallback for unmatched private chat */
export function detectDmIntent(text: string, botUsername: string): DmIntent {
  const trimmed = (text || '').trim();
  if (!trimmed) return { type: 'normal_chat' };

  // View group (regex, always fast)
  if (VIEW_GROUP_PATTERN.test(trimmed)) {
    return { type: 'view_group' };
  }

  // Try regex patterns first
  const regexResult = detectByRegex(trimmed, botUsername);
  if (regexResult) return regexResult;

  return { type: 'normal_chat' };
}

/** Async detection with AI fallback — call this when regex returns normal_chat */
export async function detectDmIntentWithAI(text: string, botUsername: string): Promise<DmIntent> {
  const trimmed = (text || '').trim();
  if (!trimmed) return { type: 'normal_chat' };

  if (VIEW_GROUP_PATTERN.test(trimmed)) {
    return { type: 'view_group' };
  }

  const regexResult = detectByRegex(trimmed, botUsername);
  if (regexResult) return regexResult;

  // Feature keyword gate: skip expensive AI call for obvious casual chat
  // Only call AI if text contains keywords that could be a DM feature
  if (!DM_FEATURE_KEYWORDS.test(trimmed)) {
    return { type: 'normal_chat' };
  }

  // AI fallback
  return detectByAI(trimmed);
}

/** Check if a target handle is a pronoun that needs AI resolution */
export function isPronounTarget(handle: string): boolean {
  return PRONOUN_SET.has(handle);
}
