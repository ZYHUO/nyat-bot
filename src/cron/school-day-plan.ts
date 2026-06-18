// ────────────────────────────────────────
// 功能 A3:每日「今日感想」— 薄 LLM 层(确定性课表 → 一句口语感想)
// ────────────────────────────────────────
//
// 三家硬约束:LLM 绝不产时间/日期/课表(那些确定性算好),只把客观安排转成一句
// 第一人称碎碎念(「今天周一又要上数学课,烦」)。缓存 Redis,每 BJ 日生成一次,
// 由 self-state 注入。SCHOOL_SCHEDULE_ENABLED 关 → no-op。

import { getRedis } from '../db/redis.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getDaySummary } from '../tracking/school-state.js';

function bjDate(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function schoolNarrativeKey(date: string): string {
  return `xxb:school:narrative:${date}`;
}

export async function runSchoolDayPlan(): Promise<void> {
  if (!env().SCHOOL_SCHEDULE_ENABLED) return;
  const redis = getRedis();
  const date = bjDate();
  const key = schoolNarrativeKey(date);
  if (await redis.get(key)) return; // 今天已生成

  const summary = getDaySummary();
  if (!summary) return;

  const prompt =
    `你是 16 岁高中生猫娘啾咪囝。下面是你今天的安排(客观事实,不许改、不许复述时间表):\n` +
    `${summary.text}\n\n` +
    `用第一人称写一句「今日感想」——你对今天的心情/期待/吐槽,口语、像发群里的碎碎念,≤30 字,只输出这一句,不要引号。`;

  try {
    const { callWithFallback } = await import('../ai/fallback.js');
    const r = await callWithFallback({
      usage: 'summarize',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 60,
      temperature: 0.85,
    });
    const line = r.content.trim().replace(/^["「'']+|["」'']+$/g, '').split('\n')[0]!.slice(0, 40);
    if (line) {
      await redis.set(key, line, 'EX', 30 * 3600);
      logger.info({ date, line }, 'School narrative generated');
    }
  } catch (err) {
    logger.debug({ err, date }, 'School narrative generation failed (non-critical)');
  }
}
