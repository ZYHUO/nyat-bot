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
import { getTopExpressions, reinforceExpressions } from '../../learners/expression-learner.js';
import { getRecentSelfReplies, selfHistoryPromptSection } from '../../tracking/self-history.js';
import { getRelationship, relationshipPromptHint } from '../../tracking/relationship.js';
import { buildCrossGroupInjection } from '../../tracking/person-identity.js';
import { getTopicLine } from '../../tracking/topic-registry.js';
import { buildProfileInjection } from '../../tracking/user-profile.js';
import { buildAliasInjection } from '../../knowledge/person-aliases.js';
import { buildSocialInjection } from '../../tracking/social-graph.js';
import { buildRoleHint } from '../../tracking/behavioral-roles.js';
import { getBotUid } from '../../bot/bot.js';

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
 * Build the 5-layer system prompt. Kept a near-pure function of (replyTier) so the prefix
 * stays byte-stable for DeepSeek/Claude auto prefix-cache. Per-user volatile data
 * (relationship / self-history) lives in the user turn now — see buildPersonalContext.
 * @param userId — optional; only used to load a per-user persona override
 *   (prompts/persona/{userId}.md|.txt) when present — rare, intentionally busts cache for that user.
 * @param _chatId — deprecated/unused (kept for call-site signature compatibility).
 */
export function buildSystemPrompt(replyTier: ReplyTier = 'normal', userId?: number, _chatId?: number): string {
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

## 动作空间(action 字段)

回字不是唯一的动作。数组元素除了文字回复,还可以是:

- \`{"action":"react","targetMessageId":123,"emoji":"😁"}\` — 只给那条消息点一个 emoji,不发文字。好笑/可爱/厉害但没什么可说的,或者只想表示"看到了",点个反应就够。emoji 只能从这里选:👍 ❤ 😁 🤣 😍 🥰 🔥 💯 👏 🤔 😢 😭 🎉 😱 🙏 👌 👀 🫡 🤗
- \`{"action":"sticker","stickerIntent":["laughing"],"targetMessageId":123}\` — 整个回应就是一张贴纸,不发字。
- \`{"action":"silent"}\` — 看了,决定不说(整个数组只放这一个元素)。插话不自然、对话不需要我时,沉默完全合法,而且经常是最像真人的选择。
- 普通文字回复**不带** action 字段。

动作元素是上面 Schema 之外的扩展形态:react/silent **不需要** replyContent,不受 Schema 的 required 约束;只发贴纸优先用 \`{"action":"sticker",…}\` 这个形态(而不是 replyContent 填 "[sticker]")。

可以组合,如 \`[{"action":"react",…对A}, {"replyContent":"…",…回B}]\`;每次最多 1 个 react、1 张贴纸。真群友不是每条都打字的——点个赞、甩张贴纸、干脆不吭声,往往更自然。`;
  }
  layers.push(contractExplanation);

  // L4: Style — 纯 tone.md。
  // ⚠️ DeepSeek/Claude prompt 前缀缓存:per-user 的 relationship hint 与 self-history
  // 以前拼在这里 → system 前缀随 (chat,user) 变动 → 自动前缀缓存几乎永不命中。
  // 已迁到 user turn(见 buildPersonalContext / buildMessages),system 前缀保持逐字节稳定。
  layers.push(loadCachedPrompt('style/tone.md'));

  // L5: Task — reply.md 是基座(目标选择/事实纪律/命令等硬规则),
  // pro/max 是叠加的"差异附录"。旧的替换式装配让 pro/max 模式下连
  // targetMessageId 硬规则都消失,深度回复反而最容易回错人。
  layers.push(loadCachedPrompt('task/reply.md'));
  if (replyTier === 'pro') layers.push(loadCachedPrompt('task/reply-pro.md'));
  else if (replyTier === 'max') layers.push(loadCachedPrompt('task/reply-max.md'));

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
 * Per-user volatile context (relationship narrative + self-history) that USED to live
 * in the system style layer. Moved to the user turn so the system prefix stays
 * byte-identical across users/turns → DeepSeek/Claude auto prefix-cache actually hits.
 */
function buildPersonalContext(chatId: number | undefined, userId: number | undefined): string | undefined {
  if (chatId === undefined || !userId) return undefined;
  const e = env();
  const parts: string[] = [];
  if (e.RELATIONSHIP_ENABLED) {
    try {
      const hint = relationshipPromptHint(getRelationship(chatId, userId));
      if (hint) parts.push(hint);
    } catch { /* non-critical */ }
  }
  if (e.SELF_HISTORY_ENABLED) {
    try {
      const replies = getRecentSelfReplies(chatId, userId, e.SELF_HISTORY_INJECT_LIMIT, e.SELF_HISTORY_WINDOW_DAYS);
      const section = selfHistoryPromptSection(replies);
      if (section) parts.push(section);
    } catch { /* non-critical */ }
  }
  // C3:跨群身份——在别的群也认识这个人时,带上跨群整体印象(同步读,陈旧时后台刷新)
  if (e.PERSON_IDENTITY_ENABLED) {
    try {
      const xg = buildCrossGroupInjection(userId, chatId);
      if (xg) parts.push(xg);
    } catch { /* non-critical */ }
  }
  return parts.length ? parts.join('\n\n') : undefined;
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
  _selfReflection?: string, // P1:已并入 [此刻的你],保留位以维持位置参数兼容
  toolResults?: string,
  replyShapeHint?: ReplyShapeHint,
  chatId?: number,
  burstHint?: string,
  expressionOverride?: string,
  midTermMemory?: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const userParts: string[] = [];

  // Runtime context: current time (kept in user turn so system prompt stays stable for caching)
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short' });
  userParts.push(`# 当前时间\n\n${timeStr}（北京时间）`);

  if (knowledge) {
    userParts.push(`[知识库]\n${knowledge}`);
  }

  // 中期记忆(MaiBot 借鉴):滚出窗口的旧对话压缩摘要,pinned 背景
  if (midTermMemory) {
    userParts.push(`[中期记忆] 更早对话的压缩摘要(背景参考,别逐句复述):\n${midTermMemory}`);
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

  // 自我反思(回复规律)已并入 reply.ts 的 [此刻的你] 状态块(P1:语义重叠,
  // 且不再单列在静态块顶端离 CURRENT_MESSAGE 老远)。此处保留入参兼容签名,
  // 但不再单独渲染。

  // Expression injection (Stage D)
  // G13: 语境匹配的 LLM 选择结果(expression-selector)优先于静态 top-N
  // G3 软性习惯框架 + G4 高 recency:不再是干巴数据表;素材块在本函数
  // 末尾(CURRENT_MESSAGE 紧前)推入,埋中间会被几千 token 稀释掉。
  // L4:风格示例化 —— 指令表("当X时可以说Y")会让模型先写正常回复再
  // 生硬缝一句"学来的话",留下接缝;few-shot 原句让它靠模仿吸收腔调。
  const EXPR_HEADER = '[群味] 本群平时说话的味道(感受语感就好,不用照搬原句):';
  const formatExprLine = (_situation: string, style: string): string => `「${style}」`;
  let expressionBlock: string | undefined;
  if (expressionOverride) {
    expressionBlock = `${EXPR_HEADER}\n${expressionOverride}`;
  } else if (chatId !== undefined && env().EXPRESSION_INJECT_ENABLED) {
    const exprs = getTopExpressions(chatId, env().EXPRESSION_INJECT_COUNT);
    if (exprs.length > 0) {
      const lines = exprs.map((e) => formatExprLine(e.situation, e.style)).join(' ');
      expressionBlock = `${EXPR_HEADER}\n${lines}`;
      // G6 使用强化:被注入即视为一次"使用",count++ → 常被用的表达爬升
      try {
        reinforceExpressions(exprs.map((e) => e.id));
      } catch { /* non-critical */ }
    }
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

  // P1:谁是谁(外号/角色/关系)紧跟对话历史 —— 模型读完对话、识别出人名后,
  // 紧接着查"谁是谁"做消歧,聚类最紧。旧位置(对话之前老远)是"先背花名册
  // 再看对话",名字对不上号(recency 衰减)。
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

  // G4(语言生命):学到的群语言放在 CURRENT_MESSAGE 紧前 —— 最高 recency,
  // 模型真正"带着群的腔调"开口,而不是被埋在状态提示堆里。
  if (expressionBlock) {
    userParts.push(expressionBlock);
  }

  // G4: burst-aware reply — answer the whole multi-message thought
  if (burstHint) {
    userParts.push(burstHint);
  }

  // DM mode: inject private chat style and capabilities hint
  if (chatId !== undefined && chatId > 0) {
    userParts.push(`[私聊模式]\n这是一对一私聊,没有旁观者:可以更亲近、更松弛,回复也可以适当长一点。\n私聊里你能做的事:记住偏好("记住xxx")、报已记住的内容("你记住了什么")、忘掉某条("忘掉xxx")、看群里在聊什么("看看群里在聊什么")、替对方去群里传话。`);
  }

  const stickerDesc = (latestMessage.sticker as { description?: string } | undefined)?.description;
  let msgText = latestMessage.textContent || latestMessage.captionContent
    || (stickerDesc && stickerDesc !== '[动态贴纸]' ? `[贴纸: ${stickerDesc}]` : stickerDesc)
    || '[空消息]';
  // ★ 消息带图时把视觉描述直接放进 CURRENT_MESSAGE——此前只在上下文行里
  // 可见,模型对"针对这张图回复"经常视而不见(review:[图片描述] 幽灵标签)
  if (latestMessage.imageDescriptions?.length) {
    const imgDesc = `[图片: ${latestMessage.imageDescriptions.join('；')}]`;
    msgText = msgText === '[空消息]' ? imgDesc : `${msgText}\n${imgDesc}`;
  }
  const safeName = sanitizeSenderString(latestMessage.fullName ?? '');
  const safeUser = sanitizeSenderString(latestMessage.username ?? '');
  const senderLabel = latestMessage.isAnonymous
    ? `${safeName}[${latestMessage.anonymousType === 'channel' ? '频道' : '匿名管理员'}]`
    : `${safeName}(@${safeUser})`;

  let currentMsgBlock = `[CURRENT_MESSAGE_TO_REPLY]\nmessage_id: ${latestMessage.messageId}\n发送者: ${senderLabel}`;
  if (latestMessage.senderTag) {
    currentMsgBlock += `\n用户Tag: ${latestMessage.senderTag}`;
  }
  // ★ replyTo 显式注入:此前只在上下文行里以「→回复 …」可见,replan 换锚
  // 或长上下文时模型经常感知不到"这条是在对我说话",回出来的内容跑题
  // (2026-06-12 用户反馈)。回复他人的消息也注明,便于指向性回应。
  if (latestMessage.replyTo) {
    const rt = latestMessage.replyTo;
    const rtName = sanitizeSenderString(rt.fullName ?? '');
    const rtSnip = (rt.textSnippet ?? '').slice(0, 60);
    currentMsgBlock += rt.uid === getBotUid()
      ? `\n回复对象: 你刚才的消息(#${rt.messageId}「${rtSnip}」)——这条消息是专门对你说的,回应它`
      : `\n回复对象: ${rtName} 的消息(#${rt.messageId}「${rtSnip}」)`;
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
  // D1:当前话题(话题生命周期注册表)——让写手知道此刻群里在聊什么、有哪些渐冷话题可回捞。
  if (chatId !== undefined && env().TOPIC_REGISTRY_ENABLED) {
    try {
      const line = getTopicLine(chatId);
      if (line) userParts.push(`[当前话题] ${line}`);
    } catch { /* non-critical */ }
  }

  // Per-user volatile context (relationship + self-history) — in the user turn, not the
  // system prefix, so the system prompt stays cache-stable. High recency (just before CURRENT).
  const personalContext = buildPersonalContext(chatId, latestMessage.uid);
  if (personalContext) userParts.push(personalContext);

  userParts.push(currentMsgBlock);

  return [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: userParts.join('\n\n') },
  ];
}

export { _resetPromptCache };
