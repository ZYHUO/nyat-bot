// ────────────────────────────────────────
// Learner Scan Cron — periodic expression + jargon extraction
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { getDb } from '../db/sqlite.js';
import { getRecent } from '../pipeline/context/manager.js';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { loadCachedPrompt } from '../shared/config.js';
import { parseLearnerOutput, upsertExpressions } from '../learners/expression-learner.js';
import { upsertJargons, getJargonsForInference } from '../learners/jargon-miner.js';
import { inferAndPersist } from '../learners/jargon-explainer.js';
import { acquireLearnerSlot, releaseLearnerSlot } from '../learners/learner-gate.js';
import type { FormattedMessage } from '../shared/types.js';

const ACTIVE_GROUPS_MAX_AGE = 30 * 86400;

async function discoverActiveGroupChats(): Promise<number[]> {
  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);
  await redis.zremrangebyscore('xxb:active_groups', '-inf', now - ACTIVE_GROUPS_MAX_AGE).catch(() => {});
  const raw = await redis.zrange('xxb:active_groups', 0, -1);
  return raw.map(Number).filter((n) => !Number.isNaN(n) && n < 0);
}

function getScanState(chatId: number): { lastMsgId: number; lastRunAt: number } {
  const db = getDb();
  const row = db.prepare('SELECT last_msg_id, last_run_at FROM learner_scan_state WHERE chat_id = ?').get(chatId) as
    | { last_msg_id: number; last_run_at: number }
    | undefined;
  return row ? { lastMsgId: row.last_msg_id, lastRunAt: row.last_run_at } : { lastMsgId: 0, lastRunAt: 0 };
}

function updateScanState(chatId: number, lastMsgId: number): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO learner_scan_state (chat_id, last_msg_id, last_run_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET last_msg_id = excluded.last_msg_id, last_run_at = excluded.last_run_at`,
  ).run(chatId, lastMsgId, now);
}

// F 复读防串台:源头过滤——广告/验证/复读类其他 bot 的消息不喂给学习器
// (codex:抽取前过滤,比 prompt 约束硬;核心防线是 botClass 而非 viaBot)
const NON_LEARNABLE_BOT_CLASS = new Set(['ad', 'verify', 'echo']);
function formatMessagesForLearner(messages: FormattedMessage[]): string {
  return messages
    .filter((m) => !(m.isBot && m.botClass && NON_LEARNABLE_BOT_CLASS.has(m.botClass)))
    .map((m) => {
      const name = m.fullName || m.username || (m.role === 'assistant' ? 'SELF' : '?');
      const text = m.textContent || m.captionContent || '[media]';
      return `[source_id:${m.messageId}] ${name}: ${text.slice(0, 200)}`;
    }).join('\n');
}

async function extractFromChat(chatId: number, messages: FormattedMessage[], e: ReturnType<typeof env>): Promise<void> {
  let systemPrompt: string;
  try {
    systemPrompt = loadCachedPrompt('task/learn-style.md');
    systemPrompt = systemPrompt.replace(/\{bot_name\}/g, e.BOT_USERNAME);
  } catch (err) {
    logger.warn({ err }, 'learner-scan: failed to load prompt');
    return;
  }

  const chatStr = formatMessagesForLearner(messages);

  try {
    const result = await callWithFallback({
      usage: e.LEARNER_SCAN_USAGE,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: chatStr },
      ],
      maxTokens: 800,
      temperature: 0,
    });

    const parsed = parseLearnerOutput(result.content);
    if (parsed.expressions.length > 0) {
      upsertExpressions(chatId, parsed.expressions);
    }
    if (parsed.jargons.length > 0) {
      upsertJargons(chatId, parsed.jargons, chatStr.slice(0, 200));
    }

    logger.info(
      { chatId, expressions: parsed.expressions.length, jargons: parsed.jargons.length },
      'learner-scan: extracted',
    );
  } catch (err) {
    logger.warn({ err, chatId }, 'learner-scan: LLM extraction failed');
  }
}

async function runJargonInference(chatId: number, e: ReturnType<typeof env>): Promise<void> {
  const thresholds = e.JARGON_INFERENCE_THRESHOLDS.split(',').map(Number).filter((n) => n > 0);
  const candidates = getJargonsForInference(chatId, thresholds);

  for (const entry of candidates.slice(0, 3)) {
    await inferAndPersist(entry, e.LEARNER_SCAN_USAGE);
  }
}

export async function runLearnerScan(opts: { exemplarOnlyChatId?: number } = {}): Promise<void> {
  const e = env();
  if (!e.LEARNER_ENABLED) return;

  let allChats: number[];
  try {
    allChats = await discoverActiveGroupChats();
  } catch (err) {
    logger.warn({ err }, 'learner-scan: failed to discover chats');
    return;
  }

  if (allChats.length === 0) return;

  // H2 修复验证:手动回填指定群 exemplar(绕过 MIN_NEW 门槛,历史不回填是线上数据,
  // 不是补测假数据 —— 资格是 getRecent 真实现场 + needsExemplars 真空库)。
  if (opts.exemplarOnlyChatId !== undefined) {
    const chatId = opts.exemplarOnlyChatId;
    try {
      const { needsExemplars, pickExemplars, saveExemplars } = await import('../learners/dialect-exemplar.js');
      if (!needsExemplars(chatId)) {
        logger.info({ chatId }, 'learner-scan: exemplar backfill skipped — already filled');
        return;
      }
      const recent = await getRecent(chatId, e.LEARNER_BATCH_SIZE);
      // H2 修2:按消息喂 pickExemplars(一人一条),不走 formatMessagesForLearner
      // —— 格式化行 join('\n') 后再 split 会把多行报告体的后续行拆成独立行
      // ("- xxx.com"/"> 疑似掉线"),绕过整行报告体检查(线上 7 条垃圾的根因)。
      const lines = recent.map((m) => {
        const name = m.fullName || m.username || (m.role === 'assistant' ? 'SELF' : '?');
        const text = (m.textContent || m.captionContent || '[media]').slice(0, 200);
        return `${name}: ${text}`;
      });
      const picked = pickExemplars(lines);
      if (picked.length > 0) saveExemplars(chatId, picked);
      logger.info({ chatId, scanned: lines.length, count: picked.length }, 'learner-scan: exemplar backfilled');
    } catch (err) {
      logger.warn({ err, chatId }, 'learner-scan: exemplar backfill failed');
    }
    return;
  }

  // Pick up to MAX_CHATS_PER_TICK
  const candidates = allChats.length <= e.LEARNER_MAX_CHATS_PER_TICK
    ? allChats
    : allChats.sort(() => Math.random() - 0.5).slice(0, e.LEARNER_MAX_CHATS_PER_TICK);

  for (const chatId of candidates) {
    const slot = await acquireLearnerSlot(chatId);
    if (!slot.ok) {
      logger.debug({ chatId, reason: slot.reason, active: slot.active }, 'learner-scan: skip — gate not acquired');
      continue;
    }
    try {
      const state = getScanState(chatId);
      const recent = await getRecent(chatId, e.LEARNER_BATCH_SIZE);

      // Filter to only new messages since last scan
      const newMsgs = recent.filter((m) => m.messageId > state.lastMsgId);
      if (newMsgs.length < e.LEARNER_MIN_NEW_MSGS) {
        logger.debug({ chatId, newMsgs: newMsgs.length, min: e.LEARNER_MIN_NEW_MSGS }, 'learner-scan: skip — not enough new msgs');
        continue;
      }

      // G1: 重检计数先于抽取 —— 已知词条在新消息里复现即 count++,
      // 这是黑话计数的主通道(抽取 LLM 不会重复报已知词)。
      try {
        const { recountJargonsInMessages } = await import('../learners/jargon-miner.js');
        recountJargonsInMessages(chatId, newMsgs.map((m) => m.textContent || '').filter(Boolean));
      } catch (err) {
        logger.debug({ err, chatId }, 'learner-scan: jargon recount failed (non-critical)');
      }

      // H2.1 exemplar 冷启动:缺方言库时用确定性挑选补 10 条(0ms,无 LLM)。
      // 与 LLM 抽取并行不互斥 —— exemplar 管"原汁语感",expressions 管"句式抽象"。
      // H2 修2:按消息喂(一人一条),不走 format+split —— 多行报告体后续行
      // ("- xxx.com"/"> 疑似")会被 split 拆成独立行绕过检查。
      try {
        const { needsExemplars, pickExemplars, saveExemplars } = await import('../learners/dialect-exemplar.js');
        if (needsExemplars(chatId)) {
          const lines = newMsgs.map((m) => {
            const name = m.fullName || m.username || (m.role === 'assistant' ? 'SELF' : '?');
            const text = (m.textContent || m.captionContent || '[media]').slice(0, 200);
            return `${name}: ${text}`;
          });
          const picked = pickExemplars(lines);
          if (picked.length > 0) {
            saveExemplars(chatId, picked);
            logger.info({ chatId, count: picked.length }, 'learner-scan: exemplar cold-start filled');
          }
        }
      } catch (err) {
        logger.debug({ err, chatId }, 'learner-scan: exemplar cold-start failed (non-critical)');
      }

      await extractFromChat(chatId, newMsgs, e);
      await runJargonInference(chatId, e);

      const maxMsgId = Math.max(...newMsgs.map((m) => m.messageId));
      updateScanState(chatId, maxMsgId);
    } catch (err) {
      logger.warn({ err, chatId }, 'learner-scan: chat failed');
    } finally {
      await releaseLearnerSlot(chatId);
    }
  }
}
