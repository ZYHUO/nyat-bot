// ────────────────────────────────────────
// Hobbies — bot 自己的爱好 (从群友爱好蒸馏而来)
// ────────────────────────────────────────
//
// 真人的爱好不是凭空来的,是从身边人、从环境里长出来的。bot 的爱好
// 同理:从本会话历史话题标签里推测兴趣。旧标签没有采集账号证据，
// 因此只可在原会话消费，不能伪称当前账号的亲身经历。
//
// 与 obsessions.ts 的关系:obsessions 是「这 3 小时迷上什么」(短周期
// 轮换的执念),hobbies 是「我长期喜欢什么」(慢变量,几天才变一次)。
// 两者都注入 self-state,但 hobbies 更稳定、更像「我是谁」的一部分。
//
// 数据流:
//   当前来源会话的 chat_topics.label → 独立蒸馏 → 带来源的持久投影
//   → 同会话 self-state。全局人物画像没有完整来源，不能混入。
// 三天只是刷新间隔，不是人格过期时间；旧无来源全局缓存不再消费。
//
// 分寸:爱好是「自我动机的底色」,不是推销话题。绝不主动开话题、绝不
// 逢人就说——只有别人正好聊到相关话题时才淡淡带一句(与 obsessions 同款)。

import { getDb } from '../db/sqlite.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { loadCachedPrompt } from '../shared/config.js';
import { canReadConversationSource, resolveConversationScope } from '../shared/privacy-scope.js';

const REFRESH_MS = 3 * 86400_000;
const CURSOR_KEY = 'xxb:hobbies:scope-cursor';
const BATCH_SIZE = 8;

function hobbyScope(chatId: number) {
  const scope = resolveConversationScope(chatId);
  if (!scope?.accountId) return null;
  return { scope: { ...scope, accountId: scope.accountId }, key: `xxb:hobbies:scoped:${scope.platform}:${scope.accountId}:${chatId}` };
}

export interface Hobby {
  topic: string;
  flavor: string;
}

/** Only explicitly scoped topic labels can contribute to this projection. */
function aggregateGroupInterests(chatId: number, limit = 40): string[] {
  const out: string[] = [];
  try {
    const db = getDb();
    // 群话题标签(最直接反映「群里在聊什么」)
    const topics = db
      .prepare(
        `SELECT label, SUM(msg_count) AS c FROM chat_topics
         WHERE chat_id = ? AND state != 'dead' GROUP BY label ORDER BY c DESC LIMIT ?`,
      )
      .all(chatId, limit) as { label: string; c: number }[];
    for (const t of topics) out.push(t.label);

    // Global person_identity interests have no complete input provenance.
    // A primary_chat_id is not proof that all of those interests came from here.
  } catch (err) {
    logger.warn({ err }, 'hobbies: aggregate interests failed');
  }
  // 去重保序
  return [...new Set(out)].slice(0, limit);
}

/** 解析 hobbies 蒸馏输出;垃圾返回 null。 */
export function parseHobbiesOutput(raw: string): Hobby[] | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    if (!Array.isArray(obj['hobbies'])) return null;
    return (obj['hobbies'] as unknown[])
      .map((h) => {
        if (typeof h !== 'object' || h === null) return null;
        const ho = h as Record<string, unknown>;
        const topic = typeof ho['topic'] === 'string' ? ho['topic'].trim().slice(0, 40) : '';
        const flavor = typeof ho['flavor'] === 'string' ? ho['flavor'].trim().slice(0, 120) : '';
        if (!topic || !flavor) return null;
        return { topic, flavor };
      })
      .filter((h): h is Hobby => h !== null)
      .slice(0, 5);
  } catch {
    return null;
  }
}

/** 蒸馏 bot 自己的爱好(LLM),写 Redis 缓存。失败静默,保留旧缓存。 */
export async function distillHobbies(chatId?: number): Promise<Hobby[] | null> {
  try {
    if (chatId === undefined) {
      // Bounded, resumable sweep. No aggregate body or derived text crosses chats.
      const cursor = Number(await getRedis().get(CURSOR_KEY) ?? Number.MIN_SAFE_INTEGER);
      const rows = getDb().prepare(`SELECT DISTINCT chat_id FROM chat_topics
        WHERE state != 'dead' AND chat_id > ? ORDER BY chat_id LIMIT ?`)
        .all(Number.isSafeInteger(cursor) ? cursor : Number.MIN_SAFE_INTEGER, BATCH_SIZE) as { chat_id: number }[];
      if (!rows.length) { await getRedis().set(CURSOR_KEY, String(Number.MIN_SAFE_INTEGER)); return null; }
      for (const row of rows) {
        await distillHobbies(row.chat_id);
        await getRedis().set(CURSOR_KEY, String(row.chat_id));
      }
      return null;
    }
    const target = hobbyScope(chatId);
    if (!target) return null;
    const previous = await getRedis().get(target.key);
    if (previous) {
      try {
        const cached = JSON.parse(previous);
        if (validLocalProjection(cached, chatId, target.scope.accountId) && Number.isFinite(cached.derivedAt)
          && Date.now() - cached.derivedAt >= 0 && Date.now() - cached.derivedAt < REFRESH_MS) return null;
      } catch { /* Invalid projections are replaceable. */ }
    }
    const interests = aggregateGroupInterests(chatId);
    if (interests.length < 3) {
      logger.info('hobbies: not enough group interests to distill, skip');
      return null;
    }
    const system = loadCachedPrompt('task/hobbies.md');
    const res = await callWithFallback({
      usage: env().HOBBY_DISTILL_USAGE,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `本会话历史话题（采集账号未知；仅推测兴趣，不能写成你的亲历或私密事实）：\n${interests.join('、')}` },
      ],
      maxTokens: 800,
      temperature: 0.5,
      allowHedge: false,
    });
    const hobbies = parseHobbiesOutput(res.content ?? '');
    if (!hobbies || hobbies.length === 0) {
      logger.info('hobbies: model produced no hobbies');
      return null;
    }
    await getRedis().set(target.key, JSON.stringify({ version: 3, derivedAt: Date.now(),
      kind: 'inferred_interest', inputKind: 'legacy_chat_topic_labels',
      sourceChatId: chatId, sourcePlatform: target.scope.platform, sourceAccountId: null,
      consumerAccountId: target.scope.accountId,
      visibility: chatId > 0 || (env().MEMORY_SENSITIVE_CHAT_IDS ?? []).includes(chatId) ? 'private' : 'contextual',
      hobbies }));
    // Retain the projection across refresh failures; a TTL must not erase identity.
    logger.info({ count: hobbies.length, chatId }, 'hobbies: scoped projection saved');
    return hobbies;
  } catch (err) {
    logger.warn({ err }, 'distillHobbies failed');
    return null;
  }
}

function validLocalProjection(record: unknown, chatId: number, accountId: string): boolean {
  if (record === null || typeof record !== 'object') return false;
  const r = record as Record<string, unknown>;
  // The consumer is bound to an account, but cannot retroactively give old
  // labels an account of origin. Unknown-origin history remains chat-local.
  return r['version'] === 3 && r['kind'] === 'inferred_interest'
    && r['inputKind'] === 'legacy_chat_topic_labels' && r['sourceChatId'] === chatId
    && r['sourceAccountId'] === null && r['consumerAccountId'] === accountId
    && canReadConversationSource(chatId, chatId, { sourcePlatform: r['sourcePlatform'] as 'telegram' | 'qq' });
}

/** 取当前 bot 的爱好(优先 Redis 缓存,无则返回空)。 */
export async function getHobbies(chatId: number): Promise<Hobby[]> {
  try {
    const target = hobbyScope(chatId);
    if (!target) return [];
    const raw = await getRedis().get(target.key);
    if (!raw) return [];
    const record = JSON.parse(raw);
    if (!validLocalProjection(record, chatId, target.scope.accountId)) return [];
    return parseHobbiesOutput(JSON.stringify({ hobbies: record.hobbies })) ?? [];
  } catch {
    return [];
  }
}

/** 注入 self-state 用的爱好短句(取第一个爱好,或空)。 */
export async function getHobbyFlavor(chatId: number): Promise<string | null> {
  const hobbies = await getHobbies(chatId);
  if (!hobbies.length) return null;
  return hobbies[0]!.flavor;
}
