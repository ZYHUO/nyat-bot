// ────────────────────────────────────────
// Topic scan cron — 廉价 LLM 抽取各活跃群「此刻在聊什么」,喂话题注册表
// ────────────────────────────────────────
//
// 每 TOPIC_SCAN_INTERVAL_MIN 分钟:对每个活跃群,用一次便宜调用(judge 档)从最近消息里
// 提一个当前话题短标签 → observeTopic;再 tickLifecycle 推进生命周期(active→cooling→dead→清理)。
// 抽取时把已有话题喂给模型,让它「还在聊就返回原标签」,避免近义话题爆炸。

import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getRecent } from '../pipeline/context/manager.js';
import { discoverActiveGroupChats } from './proactive-scan.js';
import { observeTopic, tickLifecycle, getActiveTopics } from '../tracking/topic-registry.js';
import { callWithFallback } from '../ai/fallback.js';

const MAX_CHATS_PER_TICK = 20;
const MIN_HUMAN_MSGS = 3;

async function extractTopic(chatId: number): Promise<string | null> {
  const recent = await getRecent(chatId, 15).catch(() => []);
  const humans = recent.filter((m) => !m.isBot && m.role !== 'assistant');
  if (humans.length < MIN_HUMAN_MSGS) return null;
  const ctx = humans
    .slice(-12)
    .map((m) => (m.textContent || m.captionContent || '').slice(0, 80))
    .filter(Boolean)
    .join('\n');
  if (!ctx.trim()) return null;
  const existing = getActiveTopics(chatId, 5).map((t) => t.label);
  const sys =
    '你在追踪一个群此刻在聊什么。读下面最近的消息,用 4-12 个汉字给当前主话题起一个短标签。\n' +
    '规则:\n- 还在聊已有话题之一 → 原样返回那个标签(保持连续)。\n- 话题变了 → 给个新短标签。\n' +
    '- 没有明确话题/纯灌水/只有表情贴纸 → 返回 NONE。\n只输出标签或 NONE,别的都不要。' +
    (existing.length ? `\n已有话题:${existing.join('、')}` : '');
  try {
    const res = await callWithFallback({
      usage: 'judge',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: ctx }],
      maxTokens: 24,
      temperature: 0,
    });
    const label = (res.content || '').trim().replace(/^[\s["'「『]+|[\s\]"'」』。.!?！？]+$/g, '').slice(0, 40);
    if (!label || label.toUpperCase() === 'NONE' || label.length < 2) return null;
    return label;
  } catch (err) {
    logger.debug({ err, chatId }, 'extractTopic failed (non-critical)');
    return null;
  }
}

export async function runTopicScan(): Promise<void> {
  const e = env();
  if (!e.TOPIC_REGISTRY_ENABLED) return;
  let chats: number[];
  try {
    chats = (await discoverActiveGroupChats()).slice(0, MAX_CHATS_PER_TICK);
  } catch (err) {
    logger.warn({ err }, 'topic-scan: discover failed');
    return;
  }
  let observed = 0;
  for (const chatId of chats) {
    try {
      const label = await extractTopic(chatId);
      if (label) { observeTopic(chatId, label); observed++; }
      tickLifecycle(chatId); // 推进生命周期,即使本轮没抽到话题(让旧话题正常变冷/消亡)
    } catch (err) {
      logger.debug({ err, chatId }, 'topic-scan: chat failed');
    }
  }
  if (chats.length) logger.info({ chats: chats.length, observed }, 'Topic scan tick');
}
