// ────────────────────────────────────────
// Periodic knowledge base sync (PHP cron_long_term.php parity)
// ────────────────────────────────────────

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { callWithFallback } from '../ai/fallback.js';
import { getBotUid } from '../bot/bot.js';
import { getDynamicKnowledge, updateKnowledge } from '../knowledge/manager.js';
import { getAll } from '../pipeline/context/manager.js';
import { getConfig, loadPrompt } from '../shared/config.js';
import { env } from '../env.js';
import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

const CTX_PREFIX = 'xxb:ctx:';

function stableStringifyContext(messages: unknown[]): string {
  return JSON.stringify(messages);
}

function hashPath(): string {
  const e = env();
  if (e.KNOWLEDGE_CRON_HASH_PATH) {
    return isAbsolute(e.KNOWLEDGE_CRON_HASH_PATH)
      ? e.KNOWLEDGE_CRON_HASH_PATH
      : resolve(process.cwd(), e.KNOWLEDGE_CRON_HASH_PATH);
  }
  return resolve(process.cwd(), 'data/knowledge-cron-hashes.json');
}

function loadHashes(): Record<string, string> {
  const p = hashPath();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, 'utf-8');
    const o = JSON.parse(raw) as unknown;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveHashes(hashes: Record<string, string>): void {
  const p = hashPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(hashes, null, 2), 'utf-8');
}

export async function runKnowledgeSync(): Promise<void> {
  const e = env();

  // Auto-discover all active group chats from Redis context keys
  // Fall back to explicit list if configured
  let chatIds: number[];
  if (e.KNOWLEDGE_CRON_CHAT_IDS.length > 0) {
    chatIds = e.KNOWLEDGE_CRON_CHAT_IDS;
  } else {
    const redis = getRedis();
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, found] = await redis.scan(cursor, 'MATCH', `${CTX_PREFIX}*`, 'COUNT', '200');
      cursor = next;
      keys.push(...found);
    } while (cursor !== '0');
    chatIds = keys
      .map((k) => parseInt(k.slice(CTX_PREFIX.length), 10))
      .filter((id) => !Number.isNaN(id) && id < 0); // negative = group chat
  }

  if (!chatIds.length) {
    logger.debug('Knowledge sync cron: no active group chats found, skip');
    return;
  }

  const botUid = getBotUid();
  const systemPrompt = loadPrompt('task/knowledge-summarize.md', getConfig().promptsDir);
  const hashes = loadHashes();

  for (const chatId of chatIds) {
    const start = performance.now();
    try {
      const context = await getAll(chatId);
      const payload = stableStringifyContext(context);
      const currentHash = createHash('sha256').update(payload).digest('hex');
      const lastHash = hashes[String(chatId)];

      if (currentHash === lastHash) {
        logger.debug({ chatId }, 'Knowledge sync: context unchanged, skip');
        continue;
      }

      if (context.length === 0) {
        logger.debug({ chatId }, 'Knowledge sync: empty context, skip');
        hashes[String(chatId)] = currentHash;
        continue;
      }

      const dynamicKnowledge = getDynamicKnowledge(chatId);
      let botMessages = 0;
      for (const m of context) {
        const row = m as { uid?: number };
        if (row.uid !== undefined && row.uid === botUid) botMessages++;
      }
      const totalMessages = context.length;
      const botActivityScore =
        totalMessages > 0 ? Math.round((botMessages / totalMessages) * 100) : 0;

      const inputForAI = {
        current_knowledge_base: dynamicKnowledge,
        chat_history: context,
        metadata: {
          generation_time: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
          bot_activity_score: botActivityScore,
        },
      };

      const userContent = JSON.stringify(inputForAI);

      let newKnowledgeMarkdown = '';
      let aiOk = false;
      try {
        const result = await callWithFallback({
          usage: 'summarize',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          maxTokens: 8192,
          temperature: 0.3,
        });
        newKnowledgeMarkdown = result.content.trim();
        aiOk = true;
      } catch (err) {
        logger.error({ err, chatId }, 'Knowledge sync: AI call failed');
      }

      if (aiOk) {
        hashes[String(chatId)] = currentHash;

        if (
          !newKnowledgeMarkdown ||
          newKnowledgeMarkdown === 'NO_KNOWLEDGE_UPDATE'
        ) {
          logger.debug({ chatId }, 'Knowledge sync: no update from AI');
        } else {
          updateKnowledge(chatId, newKnowledgeMarkdown);
          logger.info(
            {
              chatId,
              length: newKnowledgeMarkdown.length,
              ms: Math.round(performance.now() - start),
            },
            'Knowledge sync: file updated',
          );
        }
      }
    } catch (err) {
      logger.error({ err, chatId }, 'Knowledge sync: chat failed');
    }

    await new Promise((r) => setTimeout(r, 5000));
  }

  saveHashes(hashes);
  logger.info('Knowledge sync cron: finished');
}
