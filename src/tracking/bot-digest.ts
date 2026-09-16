// ────────────────────────────────────────
// Bot Knowledge Digest Generator
// Inline digest generation (port of PHP cron_handler.php digest logic)
// ────────────────────────────────────────

import { getBotTracker } from '../tracking/interaction.js';
import { callWithFallback } from '../ai/fallback.js';
import { logger } from '../shared/logger.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfig } from '../shared/config.js';

let _promptTemplate: string | undefined;

function getPromptTemplate(): string {
  if (_promptTemplate) return _promptTemplate;
  const promptPath = resolve(getConfig().promptsDir, 'system/summarize_bot_knowledge.md');
  _promptTemplate = readFileSync(promptPath, 'utf-8');
  return _promptTemplate;
}

function formatRawRecords(records: Array<Record<string, unknown>>): string {
  return records
    .map((rec) => {
      const ts = rec['ts'] as number;
      const d = new Date(ts * 1000);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const hh = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      const type = rec['type'] ?? '?';
      const bot = rec['bot_username'] ?? '?';
      const text = rec['text'] ?? '';
      return `[${mm}-${dd} ${hh}:${min}] ${type} @${bot}: ${text}`;
    })
    .join('\n');
}

/**
 * Try to generate a digest for a bot if enough raw records have accumulated.
 * Called inline during message processing (non-blocking, fire-and-forget).
 */
export async function tryGenerateDigest(chatId: number, botUsername: string): Promise<void> {
  const tracker = getBotTracker();
  if (!tracker) return;

  const clean = botUsername.replace(/^@/, '');

  if (!tracker.needsDigest(chatId, clean)) return;

  const rawRecords = tracker.getRawForDigest(chatId, clean, 200);
  if (rawRecords.length === 0) return;

  const existingDigest = tracker.getDigest(chatId, clean);
  const rawFormatted = formatRawRecords(rawRecords);

  const template = getPromptTemplate();
  const systemPrompt = template
    .replace('{existing_digest}', existingDigest || '（无已有摘要，首次整理）')
    .replace('{raw_records}', rawFormatted);

  try {
    const result = await callWithFallback({
      usage: 'summarize',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请根据以上记录生成/更新知识摘要。' },
      ],
      maxTokens: 1000,
      temperature: 0.3,
    });

    if (result.content) {
      tracker.saveDigest(chatId, clean, result.content);
      tracker.saveGlobalDigest(clean, result.content);
      logger.info({ bot: clean, chatId, tokens: result.tokenUsage }, 'Bot knowledge digest updated');
    }
  } catch (err) {
    logger.warn({ err, bot: clean, chatId }, 'Bot knowledge digest generation failed (non-critical)');
  }
}
