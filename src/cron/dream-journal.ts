// ────────────────────────────────────────
// Dream journal — first-person diary (CGM dream-journal analogue)
// Model decides WRITE/SKIP; multiple entries per day OK (append).
// Preferred slots: morning wake / bedtime (also hooked from sleep-cycle).
// Grounded in real Redis chat ctx — no fabrication.
// ────────────────────────────────────────

import { mkdir, writeFile, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getGlobalState } from '../meta/global-state.js';
import { sendMessage } from '../bot/sender/telegram.js';
import type { FormattedMessage } from '../shared/types.js';

export type DreamSlot = 'morning' | 'bedtime' | 'free';

function todayStamp(d = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
}

function shanghaiClock(d = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
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
    // Only use today's messages as evidence — stale/prior-day chats fed under
    // a "today" label let the model write about non-today events as if they
    // happened today. If no fresh messages, this chat contributes no evidence.
    const pick = today.slice(-30);
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
      .map((r) => {
        try {
          const o = JSON.parse(r) as { at?: number; text?: string };
          return `- ${o.at ? new Date(o.at).toISOString() : '?'} ${o.text ?? ''}`;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join('\n');
    return [local, fromRedis].filter(Boolean).join('\n') || '(无)';
  } catch {
    return local || '(无)';
  }
}

const DIARY_SYSTEM = `你是啾咪囝，决定要不要写一段日记，以及写什么。第一人称「本喵」。短段、有情绪、不是工作汇报。

输出格式（严格，违反则作废）：
- 第一行只能是：WRITE 或 SKIP（可跟空格+短原因，如 SKIP 没什么新事）
- 若 WRITE：空一行后写本段 markdown 正文（不要代码块，不要重复已有段落）
- 一次输出，直接给最终版。禁止输出思考过程、自我检查、草稿对比、规则复述。
- 禁止出现「等下」「再精简」「检查规则」「会不会太长」「再顺一遍」等元评论。
- 禁止多次 WRITE——只输出一次 WRITE + 一段正文。

硬规则：
1. 只能写「真实聊天记录」里出现过的人、事、话题、情绪；没有的一律不写。
2. 禁止虚构剧情/外号/礼物。
3. Meta digests 不可当事实。
4. 一天可以写多段；已有段落不要整篇重写，只追加新感受。
5. 早上偏「醒来碎碎念/昨晚余温」；睡前偏「收一天/困了」；没素材就 SKIP。
6. 记录很少 → 宁可 SKIP 或写两三句，不要凑字数。`;

function slotLabel(slot: DreamSlot): string {
  if (slot === 'morning') return '起床/早上';
  if (slot === 'bedtime') return '睡前';
  return '随时';
}

function stripDiaryFences(raw: string): string {
  let s = (raw || '').trim();
  // Whole-response fence, or leading/trailing fences from chatty models.
  if (/^```/.test(s)) {
    s = s.replace(/^```(?:markdown|md|text|diary)?\s*/i, '');
    s = s.replace(/\s*```\s*$/i, '');
  }
  return s.trim();
}

function normalizeDiaryHeaderLine(line: string): string {
  return line
    .trim()
    .replace(/^[*_`"'「『【（(]+/, '')
    .replace(/[*_`"'」』】）)]+$/, '')
    .replace(/^#+\s*/, '')
    .trim();
}

/**
 * Strip meta-commentary lines the model emits when thinking out loud
 * (self-correction, rule-checking, draft comparison). These are not diary
 * content — they're the model's internal monologue leaking into output.
 */
function stripMetaCommentary(body: string): string {
  const lines = body.split(/\r?\n/);
  const cleaned: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Stop at a second WRITE header (shouldn't happen after our fix, but be safe)
    if (/^(WRITE|SKIP)\b/i.test(trimmed)) break;
    // Skip meta-commentary patterns (Chinese self-correction / rule-checking)
    if (
      /^(等下|哦等下|对了[，,]?|对[，,]|哦对[，,]?|再精简|再顺|检查规则|会不会太|或者再|这样行|那个)/.test(trimmed) ||
      /(?:再精简|再顺一遍|检查规则|会不会太长|会不会太啰嗦|代码块|重复已有|规则复述|草稿|第一行是WRITE|没有虚构|符合.*人设|没有和.*重复)/.test(trimmed) ||
      // Lines that are clearly about the writing process, not diary content
      /^(对[，,]这个|对[，,]这个是新的|等下检查|等下再顺|等下会不会)/.test(trimmed)
    ) {
      continue; // skip this line
    }
    cleaned.push(line);
  }
  // Trim trailing empty lines
  while (cleaned.length > 0 && !cleaned[cleaned.length - 1]!.trim()) {
    cleaned.pop();
  }
  return cleaned.join('\n').trim();
}

/**
 * Parse WRITE/SKIP decision. Tolerates fences, bold, leading chatter,
 * and WRITE/SKIP not on the absolute first line (common with summarize models).
 *
 * Robust against models that output multiple WRITE drafts with meta-commentary:
 * finds the LAST WRITE (model's final attempt) and strips self-correction lines.
 */
export function parseDiaryDecision(raw: string): {
  action: 'WRITE' | 'SKIP';
  body: string;
  reason: string;
} {
  const text = stripDiaryFences(raw);
  if (!text) return { action: 'SKIP', body: '', reason: 'empty_output' };

  const lines = text.split(/\r?\n/);

  // Pass 1: scan entire output for all WRITE/SKIP lines (not just first 16).
  // Models that think out loud may have WRITE on line 5, then again on line 15.
  const writeIdxs: number[] = [];
  let skipIdx = -1;
  let skipReason = '';

  for (let i = 0; i < lines.length; i++) {
    const line = normalizeDiaryHeaderLine(lines[i] ?? '');
    if (!line) continue;
    const m = line.match(/^(WRITE|SKIP)(?:\s*[:：\-—]\s*|\s+|$)(.*)$/i);
    if (m?.[1]) {
      if (m[1].toUpperCase() === 'WRITE') {
        writeIdxs.push(i);
      } else {
        // SKIP — but only honor it if no WRITE found yet
        if (writeIdxs.length === 0 && skipIdx < 0) {
          skipIdx = i;
          skipReason = (m[2] || '').trim();
        }
      }
      continue;
    }
    // Chinese skip without English keyword — only if no WRITE found yet
    if (writeIdxs.length === 0 && skipIdx < 0 &&
        /(?:跳过|不写了?|没空写|没什么好写|没啥好写|不硬编|就不写了?|不想写|算了不写)/.test(line)) {
      return { action: 'SKIP', body: '', reason: line.slice(0, 80) };
    }
  }

  // Pass 2: if we found WRITE lines, use the LAST one (model's final version).
  // Walk backwards from the last WRITE in case it's truncated (too short or no ending punctuation).
  for (let j = writeIdxs.length - 1; j >= 0; j--) {
    const wIdx = writeIdxs[j]!;
    const nextWrite = j < writeIdxs.length - 1 ? writeIdxs[j + 1]! : lines.length;
    const bodyRaw = lines
      .slice(wIdx + 1, nextWrite)
      .join('\n')
      .trim()
      .replace(/^```(?:markdown|md|text)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    const body = stripMetaCommentary(bodyRaw);
    if (body.length >= 15) {
      // Check for truncation: if body doesn't end with sentence punctuation
      // and there are more WRITE attempts to try, prefer the previous one.
      const endsWithPunctuation = /[。！？!?.…]"?」?）?\]?$/.test(body);
      if (!endsWithPunctuation && j > 0) {
        // Likely truncated by max_tokens — try previous WRITE
        continue;
      }
      return {
        action: 'WRITE',
        body,
        reason: writeIdxs.length > 1 ? `last_of_${writeIdxs.length}` : '',
      };
    }
    // This WRITE's body is too short (likely truncated) — try previous WRITE
  }

  // Pass 3: no usable WRITE body — check SKIP
  if (skipIdx >= 0) {
    return { action: 'SKIP', body: '', reason: skipReason };
  }

  // Pass 4: implicit_write — model forgot the header but wrote diary content.
  // Only trigger if no WRITE was found at all (WRITE with empty body ≠ implicit).
  if (writeIdxs.length === 0) {
    const looksLikeSkipSentence = /(?:没什么.*写|没啥.*写|不写了?|不想写|没素材|没空|算了|跳过|不硬编)/.test(text);
    if (text.length >= 40 && /本喵|今天|群里/.test(text) && !looksLikeSkipSentence) {
      const cleaned = stripMetaCommentary(text);
      if (cleaned.length >= 15) {
        return { action: 'WRITE', body: cleaned, reason: 'implicit_write' };
      }
    }
  }
  return { action: 'SKIP', body: '', reason: 'unparsed' };
}

export type DreamJournalRunResult = { path: string | null; reason: string };

async function runDreamJournalInner(opts?: { slot?: DreamSlot }): Promise<DreamJournalRunResult> {
  if (!env().DREAM_JOURNAL_ENABLED) {
    return { path: null, reason: 'disabled' };
  }

  const slot: DreamSlot = opts?.slot ?? 'free';
  const day = todayStamp();
  const clock = shanghaiClock();
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

  if (evidence.msgCount === 0 && !existing) {
    logger.info({ day, slot }, 'Dream journal: no evidence, skip');
    return { path: null, reason: 'no_evidence' };
  }

  let rawOut: string;
  try {
    const result = await callWithFallback({
      usage: env().DREAM_JOURNAL_USAGE,
      messages: [
        { role: 'system', content: DIARY_SYSTEM },
        {
          role: 'user',
          content: `日期: ${day}（上海）现在 ${clock}
时段暗示: ${slotLabel(slot)}（${slot}）—— 偏好此时写，但你可以 SKIP。
活跃群 id: ${activeGroups || '(未知)'}
今日已有日记段落数: ${(existing.match(/^## /gm) ?? []).length}

## 真实聊天记录（唯一事实来源，共 ${evidence.msgCount} 条）
${evidence.text.slice(0, 12000)}

## Meta digests（仅供参考，不可当事实）
${digests}

## 已有日记（勿重复；可衔接情绪）
${existing.slice(0, 2500) || '(空)'}

请输出 WRITE/SKIP；若 WRITE 只写本段新内容。`,
        },
      ],
      maxTokens: 1200,
      temperature: 0.55,
      rejectEmpty: true,
    });
    rawOut = (result.content ?? '').trim();
    logger.info(
      { day, slot, label: result.label, model: result.model, chars: rawOut.length },
      'Dream journal LLM ok',
    );
  } catch (err) {
    logger.warn({ err, slot }, 'Dream journal LLM failed');
    return { path: null, reason: 'llm_failed' };
  }

  const decided = parseDiaryDecision(rawOut);
  if (decided.action === 'SKIP') {
    const reason = decided.reason || 'model_skip';
    logger.info(
      {
        day,
        slot,
        reason,
        rawPreview: reason === 'unparsed' || reason === 'empty_output' ? rawOut.slice(0, 240) : undefined,
      },
      'Dream journal skipped by model',
    );
    return { path: null, reason: reason === 'unparsed' || reason === 'empty_output' ? reason : `skip:${reason}` };
  }

  const body = decided.body.trim();
  if (body.length < 15) {
    logger.info(
      { day, slot, len: body.length, rawPreview: rawOut.slice(0, 240) },
      'Dream journal WRITE too short, skip',
    );
    return { path: null, reason: 'too_short' };
  }

  const heading = `## ${clock} · ${slotLabel(slot)}`;
  const chunk = `${heading}\n\n${body}\n`;
  if (!existing.trim()) {
    await writeFile(outPath, `# ${day}\n\n${chunk}\n`, 'utf8');
  } else {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    await appendFile(outPath, `${sep}${chunk}\n`, 'utf8');
  }
  logger.info(
    { path: outPath, slot, chars: body.length, evidenceMsgs: evidence.msgCount },
    'Dream journal entry appended',
  );

  // Cross-path mutex: set the cooldown key after a successful write so that
  // the cron path (runDreamJournal → runDreamJournalInner) and the sleep-edge
  // force-write path also block a subsequent Meta nudge from double-writing.
  // Without this, three trigger paths (cron / sleep-edge / Meta nudge) have no
  // shared gate — the cooldown was only set by tryWriteDreamJournal (which cron
  // bypasses entirely) and was skipped by force:true (which sleep-edge uses).
  try {
    const { getRedis } = await import('../db/redis.js');
    const cdKey = `xxb:dream:meta-cd:${day}:${slot}`;
    const cdSec = slot === 'free' ? 900 : 1800;
    await getRedis().set(cdKey, '1', 'EX', cdSec);
  } catch {
    /* non-critical — cooldown is best-effort */
  }

  const postText = `📔 ${day} ${clock}（${slotLabel(slot)}）\n\n${body.slice(0, 3500)}`;

  const channelId = normalizeJournalChatId(env().DREAM_JOURNAL_CHAT_ID);
  if (channelId !== 0) {
    try {
      await sendMessage(channelId, postText);
      logger.info({ channelId, slot }, 'Dream journal posted to channel');
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

  return { path: outPath, reason: 'wrote' };
}

export async function runDreamJournal(opts?: { slot?: DreamSlot }): Promise<string | null> {
  return (await runDreamJournalInner(opts)).path;
}

/** Infer slot from Shanghai clock for generic cron ticks. */
export function inferDreamSlot(d = new Date()): DreamSlot {
  const [hh, mm] = shanghaiClock(d).split(':').map(Number);
  const minutes = (hh ?? 0) * 60 + (mm ?? 0);
  // 05:00–10:00 morning; 21:00–02:00 bedtime window
  if (minutes >= 5 * 60 && minutes < 10 * 60) return 'morning';
  if (minutes >= 21 * 60 || minutes < 2 * 60) return 'bedtime';
  return 'free';
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

function normalizeSlot(raw?: string): DreamSlot {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'morning' || s === 'bedtime' || s === 'free') return s;
  return inferDreamSlot();
}

/**
 * Soft nudge for Meta: inject Attention so the orchestrator can call journal.tryWrite.
 * Does not write the diary itself — cron remains the reliable backup writer.
 */
export async function nudgeMetaForDream(slot?: DreamSlot | string): Promise<boolean> {
  if (!env().DREAM_JOURNAL_ENABLED || !env().META_SUBAGENT_ENABLED) return false;
  const resolved = normalizeSlot(slot);
  const master = env().MASTER_UID;
  const channel = normalizeJournalChatId(env().DREAM_JOURNAL_CHAT_ID);
  const chatId = master > 0 ? master : channel;
  if (!chatId) {
    logger.debug({ slot: resolved }, 'Dream journal Meta nudge skipped (no chatId)');
    return false;
  }
  const hint =
    resolved === 'morning'
      ? '起床窗口：可 journal.tryWrite({slot:"morning"})；没素材就别写。不要为此 dispatch 群聊。'
      : resolved === 'bedtime'
        ? '睡前窗口：可 journal.tryWrite({slot:"bedtime"})；困了/没话说就 SKIP。不要为此 dispatch 群聊。'
        : '想写日记时可 journal.tryWrite({slot:"free"})。不要为此 dispatch 群聊。';
  try {
    const { getAttentionAccumulator } = await import('../meta/attention.js');
    await getAttentionAccumulator().ingestAsync({
      chatId,
      layer: 'L1',
      reason: `diary:${resolved}`,
      textPreview: hint,
      payload: { diarySlot: resolved },
    });
    logger.info({ chatId, slot: resolved }, 'Dream journal Meta Attention nudged');
    return true;
  } catch (err) {
    logger.debug({ err, slot: resolved }, 'Dream journal Meta nudge failed');
    return false;
  }
}

/** Meta/host entry: cooldown + runDreamJournal. */
export async function tryWriteDreamJournal(opts?: {
  slot?: DreamSlot | string;
  /** Skip Redis cooldown (cron/tests). */
  force?: boolean;
}): Promise<{ wrote: boolean; path: string | null; slot: DreamSlot; reason?: string }> {
  if (!env().DREAM_JOURNAL_ENABLED) {
    return { wrote: false, path: null, slot: 'free', reason: 'disabled' };
  }
  const slot = normalizeSlot(opts?.slot);
  const day = todayStamp();
  const cdKey = `xxb:dream:meta-cd:${day}:${slot}`;
  const cdSec = slot === 'free' ? 900 : 1800;

  if (!opts?.force) {
    try {
      const { getRedis } = await import('../db/redis.js');
      const ok = await getRedis().set(cdKey, '1', 'EX', cdSec, 'NX');
      if (ok !== 'OK') {
        return { wrote: false, path: null, slot, reason: 'cooldown' };
      }
    } catch {
      /* no redis → proceed */
    }
  }

  const result = await runDreamJournalInner({ slot });
  return {
    wrote: !!result.path,
    path: result.path,
    slot,
    reason: result.reason,
  };
}
