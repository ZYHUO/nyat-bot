// ────────────────────────────────────────
// Dream journal — first-person daily diary (CGM dream-journal analogue)
// NOT the memory-dream forgetting cron.
// Grounded in real Redis chat ctx — no fabrication.
// ────────────────────────────────────────

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getGlobalState } from '../meta/global-state.js';
import { sendMessage } from '../bot/sender/telegram.js';
import type { FormattedMessage } from '../shared/types.js';

function todayStamp(d = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

/** Shanghai calendar-day start as unix seconds (CST, no DST). */
function shanghaiDayStartSec(day = todayStamp()): number {
  return Math.floor(new Date(`${day}T00:00:00+08:00`).getTime() / 1000);
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

function formatEvidenceLine(m: FormattedMessage): string {
  const who =
    m.role === 'assistant'
      ? '本喵'
      : (m.fullName || m.username || (m.uid > 0 ? `uid:${m.uid}` : 'someone'));
  const text = String(m.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return text ? `- ${who}: ${text}` : '';
}

async function loadChatEvidence(day: string): Promise<{ text: string; msgCount: number }> {
  const dayStart = shanghaiDayStartSec(day);
  const chatIds = new Set<number>();

  try {
    const { getRedis } = await import('../db/redis.js');
    const redis = getRedis();
    const groups = await redis.zrange('xxb:active_groups', -8, -1);
    for (const g of groups) {
      const id = Number(g);
      if (Number.isFinite(id) && id < 0) chatIds.add(id);
    }
  } catch {
    /* ignore */
  }

  const master = env().MASTER_UID;
  if (master > 0) chatIds.add(master);

  // Skip the diary channel itself if configured
  const journalChat = normalizeJournalChatId(env().DREAM_JOURNAL_CHAT_ID);
  if (journalChat !== 0) chatIds.delete(journalChat);

  const { getRecent } = await import('../pipeline/context/manager.js');
  const chunks: string[] = [];
  let msgCount = 0;

  for (const chatId of chatIds) {
    let msgs: FormattedMessage[] = [];
    try {
      msgs = await getRecent(chatId, 60);
    } catch {
      continue;
    }
    const today = msgs.filter((m) => (m.timestamp ?? 0) >= dayStart);
    const pick = (today.length > 0 ? today : msgs).slice(-30);
    const lines = pick.map(formatEvidenceLine).filter(Boolean);
    if (!lines.length) continue;
    msgCount += lines.length;
    const label = chatId > 0 ? `私聊 ${chatId}` : `群 ${chatId}`;
    chunks.push(`### ${label}\n${lines.join('\n')}`);
  }

  return {
    text: chunks.join('\n\n') || '(今日无可用聊天记录)',
    msgCount,
  };
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

const DIARY_SYSTEM = `你是啾咪囝，写今天的日记。第一人称「本喵」。短段、有情绪、不是工作汇报。
只写 markdown 正文（可含小标题）。不要代码块。

硬规则（违反即失败）：
1. 只能写「真实聊天记录」里出现过的人、事、话题、情绪；没有的一律不写。
2. 禁止虚构：角色关系、宠物、礼物、地点、剧情、外号（如证据没有的「小鱼干/大老婆」等）。
3. Meta digests 只是调度摘要，不能当事实来源；事实以聊天记录为准。
4. 记录很少就写短日记，并诚实说今天聊得少；不要补脑洞凑篇幅。
5. 私聊内容不要编成群聊八卦；跨会话只写证据里确实出现的。`;

export async function runDreamJournal(): Promise<string | null> {
  if (!env().DREAM_JOURNAL_ENABLED) return null;

  const day = todayStamp();
  const outPath = dreamJournalPath(day);
  await mkdir(env().DREAM_JOURNAL_DIR, { recursive: true });

  const [evidence, digests] = await Promise.all([loadChatEvidence(day), loadDigestContext()]);

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

  if (evidence.msgCount === 0) {
    logger.info({ day }, 'Dream journal: no chat evidence, skip');
    return null;
  }

  let body: string;
  try {
    const result = await callWithFallback({
      usage: env().DREAM_JOURNAL_USAGE,
      messages: [
        { role: 'system', content: DIARY_SYSTEM },
        {
          role: 'user',
          content: `日期: ${day}（上海）
活跃群 id: ${activeGroups || '(未知)'}

## 真实聊天记录（唯一事实来源，共 ${evidence.msgCount} 条）
${evidence.text.slice(0, 12000)}

## Meta digests（仅供参考，不可当事实）
${digests}

## 已有日记草稿（可续写/润色，勿重复堆砌；仍须服从证据）
${existing.slice(0, 1500) || '(空)'}

根据真实聊天记录写今天的日记。禁止瞎编。`,
        },
      ],
      maxTokens: 800,
      temperature: 0.55,
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
  logger.info({ path: outPath, chars: file.length, evidenceMsgs: evidence.msgCount }, 'Dream journal written');

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
