// ────────────────────────────────────────
// Dream journal — first-person daily diary (CGM dream-journal analogue)
// NOT the memory-dream forgetting cron.
// ────────────────────────────────────────

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getGlobalState } from '../meta/global-state.js';
import { sendMessage } from '../bot/sender/telegram.js';

function todayStamp(d = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

/** Normalize channel/supergroup ids: 3954993432 → -1003954993432 */
export function normalizeJournalChatId(raw: number): number {
  if (!raw || !Number.isFinite(raw)) return 0;
  if (raw < 0) return raw;
  return Number(`-100${raw}`);
}

export function dreamJournalPath(day?: string): string {
  const dir = env().DREAM_JOURNAL_DIR;
  return join(dir, `${day ?? todayStamp()}.md`);
}

async function loadDigestContext(): Promise<string> {
  const local = getGlobalState()
    .recentDigests(20)
    .map((d) => `- ${new Date(d.at).toISOString()} ${d.text}`)
    .join('\n');
  try {
    const { getRedis } = await import('../db/redis.js');
    const raw = await getRedis().lrange('xxb:meta:digests', 0, 19);
    const fromRedis = raw
      .map((line) => {
        try {
          const o = JSON.parse(line) as { at?: number; text?: string };
          return `- ${o.at ? new Date(o.at).toISOString() : '?'} ${o.text ?? ''}`;
        } catch {
          return `- ${line.slice(0, 160)}`;
        }
      })
      .join('\n');
    return [local, fromRedis].filter(Boolean).join('\n') || '(无)';
  } catch {
    return local || '(无)';
  }
}

export async function runDreamJournal(): Promise<string | null> {
  if (!env().DREAM_JOURNAL_ENABLED) return null;

  const day = todayStamp();
  const outPath = dreamJournalPath(day);
  await mkdir(env().DREAM_JOURNAL_DIR, { recursive: true });

  const digests = await loadDigestContext();

  let activeGroups = '';
  try {
    const { getRedis } = await import('../db/redis.js');
    const raw = await getRedis().zrange('xxb:active_groups', -8, -1);
    activeGroups = raw.join(', ');
  } catch {
    /* ignore */
  }

  let existing = '';
  try {
    existing = await readFile(outPath, 'utf8');
  } catch {
    existing = '';
  }

  let body: string;
  try {
    const result = await callWithFallback({
      usage: env().DREAM_JOURNAL_USAGE,
      messages: [
        {
          role: 'system',
          content: `你是啾咪囝，写今天的日记。第一人称「本喵」。短段、有情绪、不是工作汇报。
只写 markdown 正文（可含小标题）。不要代码块。`,
        },
        {
          role: 'user',
          content: `日期: ${day}（上海）
活跃群: ${activeGroups || '(未知)'}
Meta digests:
${digests}
已有日记草稿（可续写/润色，勿重复堆砌）:
${existing.slice(0, 1500) || '(空)'}

写今天的日记。`,
        },
      ],
      maxTokens: 800,
      temperature: 0.85,
    });
    body = (result.content ?? '').trim();
  } catch (err) {
    logger.warn({ err }, 'Dream journal LLM failed');
    return null;
  }

  if (body.length < 20) {
    logger.info({ day, len: body.length }, 'Dream journal too short, skip');
    return null;
  }

  const file = `# ${day}\n\n${body}\n`;
  await writeFile(outPath, file, 'utf8');
  logger.info({ path: outPath, chars: file.length }, 'Dream journal written');

  const postText = `📔 ${day}\n\n${body.slice(0, 3500)}`;

  const channelId = normalizeJournalChatId(env().DREAM_JOURNAL_CHAT_ID);
  if (channelId !== 0) {
    try {
      await sendMessage(channelId, postText);
      logger.info({ channelId }, 'Dream journal posted to channel');
    } catch (err) {
      logger.warn({ err, channelId }, 'Dream journal channel post failed');
    }
  }

  if (env().DREAM_JOURNAL_DM) {
    const master = env().MASTER_UID;
    if (master > 0) {
      try {
        await sendMessage(master, postText);
      } catch (err) {
        logger.warn({ err }, 'Dream journal DM failed');
      }
    }
  }

  return outPath;
}

export async function readRecentDreamSnippet(maxChars = 400): Promise<string | null> {
  try {
    const today = await readFile(dreamJournalPath(), 'utf8').catch(() => '');
    if (today.trim().length > 30) return today.trim().slice(0, maxChars);
    const y = new Date(Date.now() - 86400_000);
    const yPath = dreamJournalPath(todayStamp(y));
    const yest = await readFile(yPath, 'utf8').catch(() => '');
    return yest.trim().length > 30 ? yest.trim().slice(0, maxChars) : null;
  } catch {
    return null;
  }
}
