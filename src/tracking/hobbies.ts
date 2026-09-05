// ────────────────────────────────────────
// Hobbies — bot 自己的爱好 (从群友爱好蒸馏而来)
// ────────────────────────────────────────
//
// 真人的爱好不是凭空来的,是从身边人、从环境里长出来的。bot 的爱好
// 同理:从群友的常聊话题(topics)、稳定事实(stable_facts)、群话题标签
// (chat_topics)里聚合出「大家在乎什么」,再蒸馏成 bot 自己的爱好。
//
// 与 obsessions.ts 的关系:obsessions 是「这 3 小时迷上什么」(短周期
// 轮换的执念),hobbies 是「我长期喜欢什么」(慢变量,几天才变一次)。
// 两者都注入 self-state,但 hobbies 更稳定、更像「我是谁」的一部分。
//
// 数据流:
//   user_profiles.topics / stable_facts + chat_topics.label
//   → 聚合计数(哪些话题被反复提及)
//   → 定期 LLM 蒸馏成 3-5 个 bot 自己的爱好
//   → Redis 缓存(几天 TTL),注入 self-state
//
// 分寸:爱好是「自我动机的底色」,不是推销话题。绝不主动开话题、绝不
// 逢人就说——只有别人正好聊到相关话题时才淡淡带一句(与 obsessions 同款)。

import { getDb } from '../db/sqlite.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { loadCachedPrompt } from '../shared/config.js';

const HOBBIES_KEY = 'xxb:hobbies:current';
const HOBBIES_TTL_SEC = 3 * 86400; // 3 天重蒸馏一次

export interface Hobby {
  topic: string;
  flavor: string;
}

/** 聚合群友兴趣:user_profiles.topics/stable_facts + chat_topics.label 计数。 */
function aggregateGroupInterests(limit = 40): string[] {
  const out: string[] = [];
  try {
    const db = getDb();
    // 群话题标签(最直接反映「群里在聊什么」)
    const topics = db
      .prepare(
        `SELECT label, SUM(msg_count) AS c FROM chat_topics
         WHERE state != 'dead' GROUP BY label ORDER BY c DESC LIMIT ?`,
      )
      .all(limit) as { label: string; c: number }[];
    for (const t of topics) out.push(t.label);

    // 群友画像的长期兴趣(JSON 数组字段,person_identity.interests)
    const profTopics = db
      .prepare(`SELECT interests FROM person_identity WHERE interests IS NOT NULL AND interests != '[]' LIMIT 200`)
      .all() as { interests: string }[];
    for (const p of profTopics) {
      try {
        const arr = JSON.parse(p.interests);
        if (Array.isArray(arr)) for (const t of arr) if (typeof t === 'string' && t.trim()) out.push(t.trim());
      } catch {
        /* skip malformed */
      }
    }
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
export async function distillHobbies(): Promise<Hobby[] | null> {
  try {
    const interests = aggregateGroupInterests();
    if (interests.length < 3) {
      logger.info('hobbies: not enough group interests to distill, skip');
      return null;
    }
    const system = loadCachedPrompt('task/hobbies.md');
    const res = await callWithFallback({
      usage: env().HOBBY_DISTILL_USAGE,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `群里大家常聊/在乎的话题:\n${interests.join('、')}` },
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
    await getRedis().set(HOBBIES_KEY, JSON.stringify(hobbies), 'EX', HOBBIES_TTL_SEC);
    logger.info({ count: hobbies.length, topics: hobbies.map((h) => h.topic) }, 'hobbies: distilled');
    return hobbies;
  } catch (err) {
    logger.warn({ err }, 'distillHobbies failed');
    return null;
  }
}

/** 取当前 bot 的爱好(优先 Redis 缓存,无则返回空)。 */
export async function getHobbies(): Promise<Hobby[]> {
  try {
    const raw = await getRedis().get(HOBBIES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as Hobby[]).slice(0, 5) : [];
  } catch {
    return [];
  }
}

/** 注入 self-state 用的爱好短句(取第一个爱好,或空)。 */
export async function getHobbyFlavor(): Promise<string | null> {
  const hobbies = await getHobbies();
  if (!hobbies.length) return null;
  return hobbies[0]!.flavor;
}
