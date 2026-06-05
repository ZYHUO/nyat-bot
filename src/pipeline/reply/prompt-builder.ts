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
import { env } from '../../env.js';
import { getTopExpressions } from '../../learners/expression-learner.js';
import { getChatMood, moodPromptHint } from '../../tracking/mood.js';
import { getRecentSelfReplies, selfHistoryPromptSection } from '../../tracking/self-history.js';
import { getRelationship, relationshipPromptHint } from '../../tracking/relationship.js';
import { buildProfileInjection } from '../../tracking/user-profile.js';
import { buildAliasInjection } from '../../knowledge/person-aliases.js';
import { buildSocialInjection } from '../../tracking/social-graph.js';
import { buildRoleHint } from '../../tracking/behavioral-roles.js';

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
 * @param chatId — optional; used for per-chat mood injection (Stage E).
 */
export function buildSystemPrompt(replyTier: ReplyTier = 'normal', userId?: number, chatId?: number): string {
  const layers: string[] = [];

  // L1: Identity
  layers.push(loadPersonaForUser(userId));

  // L2: Safety
  layers.push(loadCachedPrompt('safety/guardrails.md'));

  // L3: Contract — explain JSON output format from the schema
  const schemaRaw = loadCachedPrompt('contract/reply-schema.json');
  let contractExplanation = `# L3 — 输出契约\n\n你必须严格按以下 JSON Schema 输出：\n\n\`\`\`json\n${schemaRaw}\n\`\`\`\n\n只输出 JSON 对象，不要包含任何其他文字。`;

  // G2 统一动作空间:回复不再只有"发文字"一种形态
  if (env().TURN_ACTION_PLANNER_ENABLED) {
    contractExplanation += `

## 扩展动作空间（action 字段）

数组里的每个元素除了默认的文字回复，也可以是以下动作之一：

- \`{"action":"react","targetMessageId":123,"emoji":"😁"}\` — 只对那条消息点一个 emoji 回应，不发文字。适合：好笑/可爱/厉害但你没什么可说的，或者只想表示"看到了"。emoji 只能从这些里选：👍 ❤ 😁 🤣 😍 🥰 🔥 💯 👏 🤔 😢 😭 🎉 😱 🙏 👌 👀 🫡 🤗
- \`{"action":"sticker","stickerIntent":["laughing"],"targetMessageId":123}\` — 只发一张贴纸作为整个回应，不发文字。
- \`{"action":"silent"}\` — 看了但决定不说话（整个数组只放这一个元素）。当你觉得此刻插话不自然、或者大家的对话不需要你时，沉默是完全合法、经常是最像真人的选择。
- 普通文字回复**不需要** action 字段。

可以组合：例如 \`[{"action":"react",...对A的消息}, {"replyContent":"...",...回B}]\`。每次最多 1 个 react、1 张贴纸。真人不是每条都用文字回的——点个赞、甩张贴纸、或者干脆不说话，往往更自然。

文字回复元素还可以带 \`"hesitateBefore": true\`：表示这句你想先停顿酝酿一拍再发出来（用在重点、转折、或不太好开口的那句上；整个回复最多 1 处）。`;
  }
  layers.push(contractExplanation);

  // L4: Style
  let styleLayer = loadCachedPrompt('style/tone.md');
  // Stage E: mood drift hint appended to style layer
  if (chatId !== undefined && env().MOOD_INJECT_ENABLED) {
    try {
      const mood = getChatMood(chatId);
      const hint = moodPromptHint(mood);
      if (hint) styleLayer = `${styleLayer}\n\n${hint}`;
    } catch {
      /* mood injection is non-critical; ignore errors */
    }
  }
  // Stage F: relationship narrative hint appended to style layer
  if (chatId !== undefined && userId !== undefined && env().RELATIONSHIP_ENABLED) {
    try {
      const rel = getRelationship(chatId, userId);
      const hint = relationshipPromptHint(rel);
      if (hint) styleLayer = `${styleLayer}\n\n${hint}`;
    } catch {
      /* non-critical */
    }
  }
  // Stage F: self-history hint appended to style layer
  if (chatId !== undefined && userId !== undefined && env().SELF_HISTORY_ENABLED) {
    try {
      const e = env();
      const replies = getRecentSelfReplies(
        chatId,
        userId,
        e.SELF_HISTORY_INJECT_LIMIT,
        e.SELF_HISTORY_WINDOW_DAYS,
      );
      const section = selfHistoryPromptSection(replies);
      if (section) styleLayer = `${styleLayer}\n\n${section}`;
    } catch {
      /* non-critical */
    }
  }
  layers.push(styleLayer);

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
  burstHint?: string,
  expressionOverride?: string,
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

  // Expression injection (Stage D)
  // G13: 语境匹配的 LLM 选择结果(expression-selector)优先于静态 top-N
  if (expressionOverride) {
    userParts.push(`[本群常用表达]\n${expressionOverride}`);
  } else if (chatId !== undefined && env().EXPRESSION_INJECT_ENABLED) {
    const exprs = getTopExpressions(chatId, env().EXPRESSION_INJECT_COUNT);
    if (exprs.length > 0) {
      const lines = exprs.map((e) => `- ${e.situation} → ${e.style}`).join('\n');
      userParts.push(`[本群常用表达]\n${lines}`);
    }
  }

  // Person aliases / 外号 injection (group chats) — compact durable memory of nicknames
  if (chatId !== undefined && chatId < 0) {
    try {
      const aliasBlock = buildAliasInjection(chatId);
      if (aliasBlock) userParts.push(`[群友外号]\n${aliasBlock}`);
    } catch { /* non-critical */ }
    // Behavioral roles — compact group-persona hint
    try {
      const roleBlock = buildRoleHint(chatId);
      if (roleBlock) userParts.push(`[群友角色]\n${roleBlock}`);
    } catch { /* non-critical */ }
    // Social graph — who interacts with whom (read the room)
    try {
      const socialBlock = buildSocialInjection(chatId);
      if (socialBlock) userParts.push(`[群友关系]\n${socialBlock}`);
    } catch { /* non-critical */ }
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

  // G4: burst-aware reply — answer the whole multi-message thought
  if (burstHint) {
    userParts.push(burstHint);
  }

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
  // Structured multi-section profile (#3): prefer the composed section block;
  // fall back to the legacy single profile_prompt string when no sections exist.
  let profileInjection: string | undefined;
  if (chatId !== undefined && !latestMessage.isAnonymous) {
    try {
      profileInjection = buildProfileInjection(chatId, latestMessage.uid) ?? undefined;
    } catch {
      /* non-critical; fall back to legacy below */
    }
  }
  const profileText = profileInjection ?? userProfile;
  if (profileText) {
    currentMsgBlock += `\n用户画像:\n${profileText}`;
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
