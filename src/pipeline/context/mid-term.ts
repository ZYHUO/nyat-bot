// ────────────────────────────────────────
// Mid-Term Memory — MaiBot 1.0.0 borrow(中期记忆)
// ────────────────────────────────────────
// ctx 列表(xxb:ctx:{chatId})超 CONTEXT_MAX_LENGTH 后旧消息被 Lua trim
// 静默丢弃 —— 长对话"忘前文"的直接原因。中期记忆在丢弃发生**前**把最老
// 一段压缩成 ≤200 字摘要,存独立列表 xxb:mtm:{chatId}(FIFO 上限 N 条),
// 注入 prompt 的 [中期记忆] 块。
// 设计取舍:摘要存独立键而非 ctx 内打标——ctx 有太多下游消费者
// (chat-style 统计、group-episodes、idle、retriever),混入特殊条目会
// 污染 quoteRatio/中位数等统计;独立块天然 pinned,永不被窗口裁掉。
// 并发安全:per-chat 锁(SET NX);LTRIM 前比对头部条目,被内建 trim
// 抢先动过头部就放弃裁剪(摘要照存,重叠可容忍)。

import { getRedis } from '../../db/redis.js';
import { callWithFallback } from '../../ai/fallback.js';
import { loadPrompt, getConfig } from '../../shared/config.js';
import { env } from '../../env.js';
import { logger } from '../../shared/logger.js';
import type { FormattedMessage } from '../../shared/types.js';
import { getNyatDb, unpackChatLogRow } from '../../nyatdb/index.js';

const MTM_PREFIX = 'xxb:mtm:';
const LOCK_PREFIX = 'xxb:mtm:lock:';
const NYAT_CURSOR_PREFIX = 'xxb:mtm:nyat_cursor:';
const MTM_TTL = 7 * 86400; // 与 ctx 同寿命
const LOCK_TTL_SEC = 180;

interface MidTermSummary {
  summary: string;
  fromTs: number;
  toTs: number;
  count: number;
  createdAt: number;
}

function mtmKey(chatId: number): string {
  return MTM_PREFIX + chatId;
}

// 头部比对后:裁原文 + 存摘要 + FIFO 截断 + 续期,单脚本原子完成。
// 拆成两次调用的话,裁掉原文后、摘要写入前崩溃 → 这段记忆静默空洞
// (code review #6)。头部被内建 trim 动过则整轮放弃(返回 0)。
const GUARDED_COMPRESS_LUA = `
local ctx = KEYS[1]
local mtm = KEYS[2]
if redis.call('LINDEX', ctx, 0) == ARGV[1] then
  redis.call('LTRIM', ctx, tonumber(ARGV[2]), -1)
  redis.call('RPUSH', mtm, ARGV[3])
  redis.call('LTRIM', mtm, -tonumber(ARGV[4]), -1)
  redis.call('EXPIRE', mtm, tonumber(ARGV[5]))
  return 1
end
return 0
`;

// 进程 TZ=Asia/Shanghai(systemd Environment),与 slim.ts 的上下文时间
// 同源。不要用 toISOString —— UTC 会和正文差 8 小时(code review #2)。
function fmtTs(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderForCompression(messages: FormattedMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const who = m.role === 'assistant' ? '你(bot)' : m.fullName || m.username || `uid${m.uid}`;
    const text = (m.textContent || '[非文本]').slice(0, 120);
    lines.push(`[${fmtTs(m.timestamp)}] ${who}: ${text}`);
  }
  return lines.join('\n');
}

/**
 * ctx 接近上限时压缩最老一段。fire-and-forget,绝不阻塞主管线。
 * 由 manager.addMessage 触发。
 */
export async function maybeCompressMidTerm(chatId: number): Promise<void> {
  const e = env();
  if (!e.MTM_ENABLED) return;
  // NyatDB sole chat store → compress from ChatLog; summaries still live in Redis MTM.
  if (e.NYATDB_ENABLED && e.NYATDB_DUAL_WRITE && !e.NYATDB_REDIS_MIRROR) {
    await maybeCompressMidTermFromNyat(chatId);
    return;
  }
  const redis = getRedis();
  const ctxKey = `xxb:ctx:${chatId}`;
  const threshold = e.CONTEXT_MAX_LENGTH - 20;
  const chunk = e.MTM_CHUNK;

  try {
    const len = await redis.llen(ctxKey);
    if (len < threshold) return;

    // per-chat 互斥(LLM 调用期间不重入)
    const locked = await redis.set(LOCK_PREFIX + chatId, '1', 'EX', LOCK_TTL_SEC, 'NX');
    if (!locked) return;

    try {
      const rawEntries = await redis.lrange(ctxKey, 0, chunk - 1);
      if (rawEntries.length < Math.min(chunk, 60)) return; // 太少不值得压

      const messages: FormattedMessage[] = [];
      for (const r of rawEntries) {
        try { messages.push(JSON.parse(r) as FormattedMessage); } catch { /* skip */ }
      }
      if (messages.length === 0) return;

      const config = getConfig();
      const systemPrompt = loadPrompt('task/mid-term-summary.md', config.promptsDir);
      const result = await callWithFallback({
        usage: 'summarize',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: renderForCompression(messages).slice(0, e.MTM_INPUT_MAX_CHARS) },
        ],
        maxTokens: 400,
        temperature: 0,
      });
      const summaryText = result.content.trim();
      if (!summaryText) return;

      // 裁原文+存摘要单脚本原子(头部被内建 trim 动过 → 整轮放弃,
      // 等下一轮重压 —— 先存后裁会重复,裁存分离会丢,都踩过/评过)。
      const entry: MidTermSummary = {
        summary: summaryText.slice(0, 600),
        fromTs: messages[0]!.timestamp,
        toTs: messages[messages.length - 1]!.timestamp,
        count: messages.length,
        createdAt: Date.now(),
      };
      const committed = await redis.eval(
        GUARDED_COMPRESS_LUA, 2, ctxKey, mtmKey(chatId),
        rawEntries[0]!, String(rawEntries.length), JSON.stringify(entry),
        String(e.MTM_MAX_SUMMARIES), String(MTM_TTL),
      );
      if (committed !== 1) {
        logger.info({ chatId }, 'Mid-term compression discarded (ctx head moved during LLM call)');
        return;
      }

      logger.info(
        { chatId, compressed: messages.length, summaryChars: entry.summary.length },
        'Mid-term memory compressed',
      );
    } finally {
      await redis.del(LOCK_PREFIX + chatId).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, chatId }, 'Mid-term compression failed (non-critical)');
  }
}

/**
 * NyatDB-primary mid-term: summarize oldest ring msgs that fall outside the live
 * CONTEXT_MAX_LENGTH window. Does not trim ChatLog (ring MAX handles size);
 * summaries go to the same Redis `xxb:mtm:*` list used by getMidTermBlock.
 */
async function maybeCompressMidTermFromNyat(chatId: number): Promise<void> {
  const e = env();
  const ndb = getNyatDb();
  if (!ndb) return;
  const redis = getRedis();
  const threshold = e.CONTEXT_MAX_LENGTH - 20;
  const chunk = e.MTM_CHUNK;
  const ringMax = Math.max(e.NYATDB_CHAT_RING_MAX, e.CONTEXT_MAX_LENGTH + chunk);

  try {
    const rows = ndb.chatRecent(chatId, ringMax);
    if (rows.length < threshold) return;

    const locked = await redis.set(LOCK_PREFIX + chatId, '1', 'EX', LOCK_TTL_SEC, 'NX');
    if (!locked) return;

    try {
      const all: FormattedMessage[] = [];
      for (const r of rows) {
        try {
          all.push(
            unpackChatLogRow({
              ...r,
              bodyFormat:
                r.bodyFormat === 'json' ? 'json' : r.bodyFormat === 'text' ? 'text' : undefined,
            }) as FormattedMessage,
          );
        } catch {
          /* skip */
        }
      }
      if (all.length < threshold) return;

      const cursorKey = NYAT_CURSOR_PREFIX + chatId;
      const cursor = Number(await redis.get(cursorKey)) || 0;
      const liveStart = Math.max(0, all.length - e.CONTEXT_MAX_LENGTH);
      const compressible = all.slice(0, liveStart).filter((m) => m.messageId > cursor);
      if (compressible.length < Math.min(chunk, 60)) return;

      const messages = compressible.slice(0, chunk);
      const config = getConfig();
      const systemPrompt = loadPrompt('task/mid-term-summary.md', config.promptsDir);
      const result = await callWithFallback({
        usage: 'summarize',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: renderForCompression(messages).slice(0, e.MTM_INPUT_MAX_CHARS) },
        ],
        maxTokens: 400,
        temperature: 0,
      });
      const summaryText = result.content.trim();
      if (!summaryText) return;

      const entry: MidTermSummary = {
        summary: summaryText.slice(0, 600),
        fromTs: messages[0]!.timestamp,
        toTs: messages[messages.length - 1]!.timestamp,
        count: messages.length,
        createdAt: Date.now(),
      };
      const lastId = messages[messages.length - 1]!.messageId;
      await redis
        .multi()
        .rpush(mtmKey(chatId), JSON.stringify(entry))
        .ltrim(mtmKey(chatId), -e.MTM_MAX_SUMMARIES, -1)
        .expire(mtmKey(chatId), MTM_TTL)
        .set(cursorKey, String(lastId), 'EX', MTM_TTL)
        .exec();

      logger.info(
        { chatId, compressed: messages.length, summaryChars: entry.summary.length, lastId },
        'Mid-term memory compressed (NyatDB)',
      );
    } finally {
      await redis.del(LOCK_PREFIX + chatId).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, chatId }, 'Mid-term NyatDB compression failed (non-critical)');
  }
}

/** prompt 注入块;没有摘要返回 null。 */
export async function getMidTermBlock(chatId: number): Promise<string | null> {
  if (!env().MTM_ENABLED) return null;
  try {
    const raw = await getRedis().lrange(mtmKey(chatId), 0, -1);
    if (raw.length === 0) return null;
    const lines: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      try {
        const s = JSON.parse(raw[i]!) as MidTermSummary;
        lines.push(`${i + 1}. (${fmtTs(s.fromTs)}~${fmtTs(s.toTs)}, ${s.count}条) ${s.summary}`);
      } catch { /* skip corrupted */ }
    }
    if (lines.length === 0) return null;
    return lines.join('\n');
  } catch (err) {
    logger.debug({ err, chatId }, 'getMidTermBlock failed (non-critical)');
    return null;
  }
}

/** 测试用 */
export async function _clearMidTerm(chatId: number): Promise<void> {
  await getRedis().del(mtmKey(chatId), LOCK_PREFIX + chatId, NYAT_CURSOR_PREFIX + chatId);
}
