// ────────────────────────────────────────
// DM Intent Detector — regex fast path + AI fallback
// ────────────────────────────────────────

import { callWithFallback } from '../../ai/fallback.js';
import { logger } from '../../shared/logger.js';

export type DmIntent =
  | { type: 'normal_chat' }
  | { type: 'view_group'; groupHint?: string }
  | { type: 'relay_message'; targetHandle: string; content: string; groupHint?: string };

const VIEW_GROUP_PATTERN = /(?:帮我?)?(?:看看?|查看|瞅瞅|看下|瞄一眼)群|群里?(?:在聊什么|最近|消息|动态|有什么|聊了什么|怎么样|在说什么|说了什么)|群聊?(?:记录|消息|内容)/i;

// @handle message
const AT_RELAY_PATTERN = /^@(\S+)\s+([\s\S]+)/;

// Pronouns that need AI resolution
const PRONOUN_SET = new Set(['他', '她', 'ta', 'TA', 'Ta', '它', '那个人', '那位', '对方']);

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

/** AI-based intent detection — catches natural language like "你在群里@一下奶昔" */
async function detectByAI(text: string): Promise<DmIntent> {
  try {
    const result = await callWithFallback({
      usage: 'judge',
      messages: [
        {
          role: 'system',
          content: `判断用户私聊消息的意图。三种可能：
1. relay_message — 用户想让bot在群里@某人、传话、带话、发消息给某人
2. view_group — 用户想看群里在聊什么
3. normal_chat — 普通聊天，和relay无关

仅输出JSON:
{"type": "relay_message", "target": "目标人名/用户名/代词", "content": "要传达的内容", "group_hint": "群名关键词或null"}
或 {"type": "view_group"}
或 {"type": "normal_chat"}

注意：
- target 可以是具体名字、@username、或代词（他/她）
- content 如果用户没明确说要发什么，设为 null
- group_hint 如果用户提到了群名，提取关键词`,
        },
        { role: 'user', content: text },
      ],
      maxTokens: 100,
      temperature: 0,
    });

    const cleaned = result.content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned) as {
      type?: string;
      target?: string;
      content?: string | null;
      group_hint?: string | null;
    };

    if (parsed.type === 'relay_message' && parsed.target) {
      return {
        type: 'relay_message',
        targetHandle: parsed.target,
        content: parsed.content || '__infer_from_context__',
        groupHint: parsed.group_hint || undefined,
      };
    }

    if (parsed.type === 'view_group') {
      return { type: 'view_group' };
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

  // AI fallback
  return detectByAI(trimmed);
}

/** Check if a target handle is a pronoun that needs AI resolution */
export function isPronounTarget(handle: string): boolean {
  return PRONOUN_SET.has(handle);
}
