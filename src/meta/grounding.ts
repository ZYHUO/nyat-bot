// ────────────────────────────────────────
// 并行 Grounding（联网事实核查，CGM 借鉴）
// 事实/问题类消息在 autoDispatch 的同时后台起一次联网搜索：脱敏 → executeSearch
// （复用 web.search 同一条搜索链）→ 便宜 LLM 压成 digest → Redis 短 TTL 存放。
// CodeAct executor 任务开头自取（takeGrounding，一次性）。
// 严格 guardrail：无搜索证据 / 任何失败 → 什么都不存。全程 GROUNDING_ENABLED 门控，
// 关掉时零行为变化；开着时任何错误也绝不冒泡进 dispatch / 执行主链路。
// ────────────────────────────────────────

import { callWithFallback } from '../ai/fallback.js';
import { getRedis } from '../db/redis.js';
import { env } from '../env.js';
import { executeSearch } from '../pipeline/tools/search.js';
import { logger } from '../shared/logger.js';

const DIGEST_TTL_S = 600; // digest 10min 过期（派发→执行正常就几秒）
const PENDING_TTL_S = 30; // pending 标记只用于 executor 决定要不要轮询
const RATE_LIMIT_WINDOW_S = 600;
const RATE_LIMIT_MAX = 3; // 每 chat 每 10min 最多 3 次核查
const MIN_TEXT_LEN = 8; // 短于这个的问句没有核查价值（「真的吗？」）
const DIGEST_MAX_CHARS = 600;

function digestKey(chatId: number, messageId: number): string {
  return `xxb:grounding:${chatId}:${messageId}`;
}
function pendingKey(chatId: number, messageId: number): string {
  return `xxb:grounding:pending:${chatId}:${messageId}`;
}
function rateLimitKey(chatId: number): string {
  return `xxb:grounding:rl:${chatId}`;
}

/**
 * 廉价启发式：这条消息像不像「事实/问题」？命中才值得联网核查。
 * 接受：长度 ≥ 8 且（含 ?/？ 或 疑问词：什么/怎么/为什么/多少/谁/哪/是不是/真的吗）。
 * 拒绝：纯闲聊（哈哈哈/在吗/表情包式短句天然不含疑问词且长度不够）。
 */
export function looksFactualQuestion(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length < MIN_TEXT_LEN) return false;
  if (/[?？]/.test(t)) return true;
  return /什么|怎么|为什么|多少|谁|哪|是不是|真的吗/.test(t);
}

/**
 * 隐私脱敏（CGM sanitizeForGrounding 的单消息版）：
 * - 去 @mention（@username、@中文名）
 * - 去 uid 痕迹（uid:123 / uid=123 / 裸 UID:123）
 * - 去常见时间戳（[2024-01-01 12:00] / [12:00]）
 * - 保留事实核心正文不动
 */
export function sanitizeForGrounding(text: string): string {
  let t = String(text ?? '');

  // @mention（TG username 是 [A-Za-z0-9_]，中文圈也常见 @中文昵称）
  t = t.replace(/@[\w\u4e00-\u9fff]+/g, '');

  // uid 显式痕迹：uid:6251541967 / uid=123 / UID 123
  t = t.replace(/\buid\s*[:=]?\s*\d{4,12}\b/gi, '某人');

  // 时间戳：[2024-01-01 12:00(:ss)] / [12:00(:ss)]
  t = t.replace(/\[\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\]/g, '');
  t = t.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '');

  // 收敛空白
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

/** executeSearch 的失败/无结果串不算证据（与 pipeline/tools/search.ts 的措辞对齐）。 */
function hasSearchEvidence(raw: string): boolean {
  const t = (raw ?? '').trim();
  if (!t) return false;
  if (t.startsWith('搜索失败')) return false;
  if (t.includes('没有找到与')) return false;
  if (t === '(no results)') return false;
  return true;
}

/**
 * 命中启发式则后台跑一轮核查并写 Redis。fire-and-forget：调用方 `void` 掉即可；
 * 内部全 try/catch，永不 reject，绝不阻塞 dispatch。
 */
export async function maybeStartGrounding(opts: {
  chatId: number;
  messageId: number;
  text: string;
}): Promise<void> {
  try {
    if (!env().GROUNDING_ENABLED) return;
    const { chatId, messageId } = opts;
    if (!messageId || messageId <= 0) return;
    if (!looksFactualQuestion(opts.text)) return;

    const query = sanitizeForGrounding(opts.text);
    if (query.length < MIN_TEXT_LEN) return;

    const redis = getRedis();

    // 限流：每 chat 10min 最多 3 次（INCR 到 1 时挂窗口 TTL）
    const rlKey = rateLimitKey(chatId);
    const n = await redis.incr(rlKey);
    if (n === 1) await redis.expire(rlKey, RATE_LIMIT_WINDOW_S);
    if (n > RATE_LIMIT_MAX) {
      logger.info({ chatId, messageId, n }, 'grounding rate-limited');
      return;
    }

    // pending 标记：executor 只在它存在时才轮询（否则一次 cheap 读取就走，
    // 不为非问题类消息白等 6s）。
    await redis.set(pendingKey(chatId, messageId), '1', 'EX', PENDING_TTL_S);
    try {
      const raw = await executeSearch(query.slice(0, 200));
      if (!hasSearchEvidence(raw)) {
        logger.info({ chatId, messageId }, 'grounding: no search evidence, dropped');
        return;
      }

      const res = await callWithFallback({
        usage: env().GROUNDING_USAGE,
        messages: [
          {
            role: 'system',
            content:
              '你是事实核查摘要器。把搜索结果压成 150 字内的中文要点：只留与问题直接相关的事实结论，' +
              '去掉来源列表/客套/过程描述。信息矛盾或不确定就直说。不要称呼提问者。',
          },
          { role: 'user', content: `问题：${query}\n\n搜索结果：\n${raw.slice(0, 3000)}` },
        ],
        maxTokens: 300,
        temperature: 0.2,
        allowHedge: false, // 后台任务，hedge 双发纯翻倍账单
      });
      const digest = (res.content ?? '').trim().slice(0, DIGEST_MAX_CHARS);
      if (!digest) return;

      await redis.set(digestKey(chatId, messageId), digest, 'EX', DIGEST_TTL_S);
      logger.info(
        { chatId, messageId, query: query.slice(0, 60), chars: digest.length },
        'grounding digest stored',
      );
    } finally {
      await redis.del(pendingKey(chatId, messageId)).catch(() => {});
    }
  } catch (err) {
    logger.warn(
      { err, chatId: opts.chatId, messageId: opts.messageId },
      'grounding failed (non-critical)',
    );
  }
}

/** executor 拾取：读 + 删（一次性）。任何异常 → null。 */
export async function takeGrounding(chatId: number, messageId: number): Promise<string | null> {
  try {
    if (!env().GROUNDING_ENABLED) return null;
    const redis = getRedis();
    const key = digestKey(chatId, messageId);
    const v = await redis.get(key);
    if (!v) return null;
    await redis.del(key);
    return v;
  } catch {
    return null;
  }
}

/** executor 用它决定要不要短轮询：没有 pending 就不等（避免白等 6s）。 */
export async function isGroundingPending(chatId: number, messageId: number): Promise<boolean> {
  try {
    if (!env().GROUNDING_ENABLED) return false;
    return !!(await getRedis().get(pendingKey(chatId, messageId)));
  } catch {
    return false;
  }
}
