// ────────────────────────────────────────
// Agent Builtin Tools — MaiBot 1.0.0 borrow
// ────────────────────────────────────────
// MaiBot Maisaka 的 builtin_tool 对应物:让模型在 plan→act 循环里按需
// 拉取记忆/画像/历史,而不是全靠管线预注入。query_jargon 已有
// (jargon-tool.ts),这里补 query_memory / query_person_profile /
// fetch_history / send_image 四个。
// 设计约束:全部只读且容错(查不到返回提示文本,不 throw),除 send_image
// 是唯一的出站副作用——发送后写 ctx 簿记,避免 bot 自己都不记得发过图。

import { z } from 'zod';
import { searchMemory } from '../../memory/chroma.js';
import { getProfileSections, getUserPreferences } from '../../tracking/user-profile.js';
import { getRelationship, relationshipPromptHint } from '../../tracking/relationship.js';
import { getChatAliases } from '../../knowledge/person-aliases.js';
import { getAll, getGroupMembers, addAssistant } from '../context/manager.js';
import { getBot } from '../../bot/bot.js';
import { logger } from '../../shared/logger.js';

// 进程 TZ=Asia/Shanghai(systemd Environment),与 slim.ts 的上下文时间戳
// 同源 —— 不要用 toISOString(UTC),摘要/记忆里的时间会和正文差 8 小时。
function fmtTs(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// AI SDK v4:工具 execute 抛异常会让**整个** generateText reject(已查
// node_modules 源码确认),换 label 重跑、已执行步骤全丢。所有查询工具
// 必须自兜底,把故障变成给模型看的文本。
function toolGuard(err: unknown, tool: string, chatId: number): string {
  logger.warn({ err, tool, chatId }, 'agent tool failed (returned as text)');
  return '(工具暂时故障,换个方式回答或如实说查不到)';
}

export const queryMemorySchema = z.object({
  query: z.string().describe('要回忆的内容关键词或问题,如"上次谁说要去日本"'),
});

export async function executeQueryMemory(chatId: number, query: string): Promise<string> {
  try {
    const hits = await searchMemory(chatId, query, 6, 1500);
    if (hits.length === 0) return '(长期记忆里没有找到相关内容)';
    const lines = hits.map((m) => {
      const when = m.timestamp ? fmtTs(m.timestamp).slice(0, 5) : '?';
      return `[${when}] ${m.fullName || m.username || 'unknown'}: ${(m.textContent || '').slice(0, 120)}`;
    });
    return `长期记忆检索结果(按相关度):\n${lines.join('\n')}`;
  } catch (err) {
    return toolGuard(err, 'QUERY_MEMORY', chatId);
  }
}

export const queryPersonProfileSchema = z.object({
  name: z.string().describe('群友的名字、昵称或 @username(不含@)'),
});

export async function executeQueryPersonProfile(chatId: number, name: string): Promise<string> {
  try {
    return await queryPersonProfileInner(chatId, name);
  } catch (err) {
    return toolGuard(err, 'QUERY_PERSON_PROFILE', chatId);
  }
}

async function queryPersonProfileInner(chatId: number, name: string): Promise<string> {
  let needle = name.replace(/^@/, '').toLowerCase();
  // 外号解析:普通 reply 路径靠 buildAliasInjection 认得外号,工具也得认
  try {
    const aliases = getChatAliases(chatId, 50);
    const aliasHit = aliases.find((a) => a.alias.toLowerCase() === needle);
    if (aliasHit) needle = aliasHit.subject_name.toLowerCase();
  } catch { /* 外号表缺失不影响主流程 */ }
  const members = await getGroupMembers(chatId);
  const hit = members.find(
    (m) =>
      m.username.toLowerCase() === needle ||
      m.fullName.toLowerCase() === needle ||
      m.fullName.toLowerCase().includes(needle),
  );
  if (!hit) return `(本群没找到叫「${name}」的人;成员名单里最近活跃的有:${members.slice(0, 8).map((m) => m.fullName).join('、') || '无记录'})`;

  const parts: string[] = [`${hit.fullName}(@${hit.username || '无username'}, uid=${hit.uid})`];
  const sections = getProfileSections(chatId, hit.uid);
  if (sections.length > 0) {
    parts.push(...sections.map((s) => `${s.section_name}: ${s.bullets.join(';')}`));
  }
  const prefs = getUserPreferences(chatId, hit.uid);
  if (prefs) parts.push(`偏好记录: ${prefs}`);
  try {
    const hint = relationshipPromptHint(getRelationship(chatId, hit.uid));
    if (hint) parts.push(`你和TA: ${hint}`);
  } catch {
    /* relationship 缺失不影响画像主体 */
  }
  if (parts.length === 1) parts.push('(还没有积累画像,只认得这个人)');
  return parts.join('\n');
}

export const fetchHistorySchema = z.object({
  before_message_id: z
    .number()
    .optional()
    .describe('从这条消息 id 往前翻;省略则从当前窗口最早的消息往前'),
  count: z.number().min(5).max(80).default(40).describe('要取的消息条数(5-80)'),
});

export async function executeFetchHistory(
  chatId: number,
  beforeMessageId: number | undefined,
  count: number,
): Promise<string> {
  try {
    return await fetchHistoryInner(chatId, beforeMessageId, count);
  } catch (err) {
    return toolGuard(err, 'FETCH_HISTORY', chatId);
  }
}

async function fetchHistoryInner(
  chatId: number,
  beforeMessageId: number | undefined,
  count: number,
): Promise<string> {
  const all = await getAll(chatId, 500);
  let cutoff = all.length;
  if (beforeMessageId !== undefined) {
    const idx = all.findIndex((m) => m.messageId === beforeMessageId);
    if (idx >= 0) cutoff = idx;
  }
  const slice = all.slice(Math.max(0, cutoff - count), cutoff);
  if (slice.length === 0) return '(没有更早的历史了)';
  const lines = slice.map((m) => {
    const who = m.role === 'assistant' ? '你' : m.fullName || m.username || 'unknown';
    return `#${m.messageId} ${who}: ${(m.textContent || '[非文本]').slice(0, 100)}`;
  });
  return `更早的历史(${slice.length} 条,旧→新):\n${lines.join('\n')}`;
}

export const sendImageSchema = z.object({
  message_id: z.number().describe('上下文里带图消息的 message_id(上下文中标注了哪些消息有图)'),
  caption: z.string().optional().describe('随图说的一句话(可选,保持人设语气)'),
});

export async function executeSendImage(
  chatId: number,
  messageId: number,
  caption?: string,
): Promise<string> {
  let all;
  try {
    all = await getAll(chatId, 500);
  } catch (err) {
    return toolGuard(err, 'SEND_IMAGE', chatId);
  }
  const msg = all.find((m) => m.messageId === messageId);
  if (!msg) return `(找不到消息 #${messageId})`;
  if (!msg.imageFileId) return `(消息 #${messageId} 没有图片,不要瞎指)`;
  try {
    const bot = getBot();
    const sent = await bot.api.sendPhoto(chatId, msg.imageFileId, caption ? { caption } : undefined);
    // ctx 簿记:不记的话 bot 下一回合不知道自己发过这张图
    await addAssistant(chatId, {
      textContent: caption ? `[转发了一张图] ${caption}` : '[转发了一张图]',
      messageId: sent.message_id,
    });
    return `图片已发送(message_id=${sent.message_id})。不要再在文字回复里重复描述这张图。`;
  } catch (err) {
    logger.warn({ err, chatId, messageId }, 'send_image tool failed');
    return '(图片发送失败,改用文字回复)';
  }
}
