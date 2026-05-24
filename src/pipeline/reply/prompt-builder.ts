// ────────────────────────────────────────
// 5-Layer Prompt Builder
// ────────────────────────────────────────
// L1: Identity (persona.md)
// L2: Safety (guardrails.md)
// L3: Contract (reply-schema.json)
// L4: Style (tone.md)
// L5: Task (reply.md or reply-pro.md)
// ────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FormattedMessage, ReplyTier } from '../../shared/types.js';
import { loadCachedPrompt, _resetPromptCache, getConfig } from '../../shared/config.js';

const SECTION_SEP = '\n\n---\n\n';

function loadPersonaForUser(userId: number | undefined): string {
  if (!userId) {
    return loadCachedPrompt('identity/persona.md');
  }
  const { personaDir } = getConfig();
  const md = resolve(personaDir, `${userId}.md`);
  const txt = resolve(personaDir, `${userId}.txt`);
  for (const path of [md, txt]) {
    try {
      return readFileSync(path, 'utf-8').trim();
    } catch {
      /* file not found, try next */
    }
  }
  return loadCachedPrompt('identity/persona.md');
}

/**
 * Build the 5-layer system prompt.
 * @param userId — optional; loads prompts/persona/{userId}.md|.txt when present (PHP PersonaManager parity).
 */
export function buildSystemPrompt(replyTier: ReplyTier = 'normal', userId?: number): string {
  const layers: string[] = [];

  // L1: Identity
  layers.push(loadPersonaForUser(userId));

  // L2: Safety
  layers.push(loadCachedPrompt('safety/guardrails.md'));

  // L3: Contract — explain JSON output format from the schema
  const schemaRaw = loadCachedPrompt('contract/reply-schema.json');
  const contractExplanation = `# L3 — 输出契约\n\n你必须严格按以下 JSON Schema 输出：\n\n\`\`\`json\n${schemaRaw}\n\`\`\`\n\n只输出 JSON 对象，不要包含任何其他文字。`;
  layers.push(contractExplanation);

  // L4: Style
  layers.push(loadCachedPrompt('style/tone.md'));

  // L5: Task
  const taskFile = replyTier === 'max' ? 'task/reply-max.md'
    : replyTier === 'pro' ? 'task/reply-pro.md'
    : 'task/reply.md';
  layers.push(loadCachedPrompt(taskFile));

  return layers.filter(Boolean).join(SECTION_SEP);
}

/**
 * Strip ASCII control characters (except newline) and truncate to maxLen.
 * Used to sanitize user-controlled strings injected into prompts.
 */
function sanitizeSenderString(s: string, maxLen = 64): string {
  // Remove control chars \x00-\x1f except \n (0x0a)
  return s.replace(/[\x00-\x09\x0b-\x1f]/g, '').slice(0, maxLen);
}

export interface ReplyShapeHint {
  exactReplyCount?: number;
}

/**
 * Build the messages array for AI call.
 */
export function buildMessages(
  systemPrompt: string,
  context: string,
  latestMessage: FormattedMessage,
  knowledge?: string,
  checkinData?: string,
  memberRoster?: string,
  botKnowledge?: string,
  userProfile?: string,
  userPreferences?: string,
  selfReflection?: string,
  toolResults?: string,
  replyShapeHint?: ReplyShapeHint,
  chatId?: number,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const userParts: string[] = [];

  // Runtime context: current time (kept in user turn so system prompt stays stable for caching)
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short' });
  userParts.push(`# 当前时间\n\n${timeStr}（北京时间）`);

  if (knowledge) {
    userParts.push(`[知识库]\n${knowledge}`);
  }

  if (checkinData) {
    userParts.push(checkinData);
  }

  if (memberRoster) {
    userParts.push(`[群成员]\n${memberRoster}`);
  }

  if (botKnowledge) {
    userParts.push(`[群组Bot知识]\n${botKnowledge}`);
  }

  if (selfReflection) {
    userParts.push(`[自我反思·回复规律]\n${selfReflection}`);
  }

  if (toolResults) {
    userParts.push(toolResults);
  }

  if (replyShapeHint?.exactReplyCount && replyShapeHint.exactReplyCount > 1) {
    userParts.push(
      `[REPLY_COUNT_REQUIREMENT]\n必须输出恰好 ${replyShapeHint.exactReplyCount} 条消息，并使用 JSON 数组返回，不能合并成一条。`,
    );
  }

  const contextLabel = chatId !== undefined && chatId > 0 ? '私聊上下文' : '群聊上下文';
  userParts.push(`[${contextLabel}]\n${context}`);

  // DM mode: inject private chat style and capabilities hint
  if (chatId !== undefined && chatId > 0) {
    userParts.push(`[私聊模式]\n这是一对一的私聊对话。你可以更亲近、更自然地交流，回复可以适当长一些。\n你在私聊中的能力：帮用户记住偏好（"记住xxx"）、查看已记住的内容（"你记住了什么"）、忘记某条偏好（"忘掉xxx"）、查看群消息摘要（"看看群里在聊什么"）、帮用户在群里传话。`);
  }

  const stickerDesc = (latestMessage.sticker as { description?: string } | undefined)?.description;
  const msgText = latestMessage.textContent || latestMessage.captionContent
    || (stickerDesc && stickerDesc !== '[动态贴纸]' ? `[贴纸: ${stickerDesc}]` : stickerDesc)
    || '[空消息]';
  const safeName = sanitizeSenderString(latestMessage.fullName ?? '');
  const safeUser = sanitizeSenderString(latestMessage.username ?? '');
  const senderLabel = latestMessage.isAnonymous
    ? `${safeName}[${latestMessage.anonymousType === 'channel' ? '频道' : '匿名管理员'}]`
    : `${safeName}(@${safeUser})`;

  let currentMsgBlock = `[CURRENT_MESSAGE_TO_REPLY]\nmessage_id: ${latestMessage.messageId}\n发送者: ${senderLabel}`;
  if (latestMessage.senderTag) {
    currentMsgBlock += `\n用户Tag: ${latestMessage.senderTag}`;
  }
  if (userProfile) {
    currentMsgBlock += `\n用户画像: ${userProfile}`;
  }
  if (userPreferences) {
    currentMsgBlock += `\n用户偏好记录:\n${userPreferences}`;
  }
  currentMsgBlock += `\n内容: ${msgText}`;
  userParts.push(currentMsgBlock);

  return [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userParts.join('\n\n') },
  ];
}

export { _resetPromptCache };
