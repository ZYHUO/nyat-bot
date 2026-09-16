// ────────────────────────────────────────
// P1-D: Gate 决策历史 — gate 有状态化
// ────────────────────────────────────────
//
// MaiBot 的 timing gate 与 planner 共享同一份对话历史,能看到自己过往的节奏
// 分析与决策;我们的 gate 是独立一跳,历史上完全无状态 → 反复横跳/连续 wait
// 拖延。这里给 gate 一个最小的"自我记忆":最近 5 次真实 LLM 决策的环形缓冲,
// 注入 prompt 供下次判断参考。只记真实解析成功的决策(短路/合成 no_action
// 不记),对齐"共享历史里只有 gate 自己真正说过的话"。

import { getRedis } from '../../db/redis.js';
import { logger } from '../../shared/logger.js';
import type { GateAction } from './gate.js';

export interface GateHistEntry {
  action: GateAction;
  waitSec?: number;
  reason: string;
  ts: number;
}

const HIST_KEY_PREFIX = 'xxb:timing:gatehist:';
const HIST_MAX = 5;
const HIST_TTL_SEC = 3600;

function key(chatId: number): string {
  return `${HIST_KEY_PREFIX}${chatId}`;
}

/** 真实 LLM 决策后追加(LPUSH+LTRIM+EXPIRE 单 MULTI)。fire-and-forget 安全。 */
export async function appendGateHistory(chatId: number, entry: GateHistEntry): Promise<void> {
  const redis = getRedis();
  const k = key(chatId);
  try {
    const pipeline = redis.pipeline();
    pipeline.lpush(k, JSON.stringify(entry));
    pipeline.ltrim(k, 0, HIST_MAX - 1);
    pipeline.expire(k, HIST_TTL_SEC);
    await pipeline.exec();
  } catch (err) {
    logger.debug({ err, chatId }, 'appendGateHistory failed (non-critical)');
  }
}

/** 最近→最久(LRANGE 0..4;坏条目跳过)。 */
export async function getGateHistory(chatId: number): Promise<GateHistEntry[]> {
  const redis = getRedis();
  try {
    const raw = await redis.lrange(key(chatId), 0, HIST_MAX - 1);
    const out: GateHistEntry[] = [];
    for (const item of raw) {
      try {
        const parsed = JSON.parse(item) as GateHistEntry;
        if (
          parsed &&
          (parsed.action === 'continue' || parsed.action === 'wait' || parsed.action === 'no_action') &&
          typeof parsed.ts === 'number'
        ) {
          out.push(parsed);
        }
      } catch { /* skip malformed */ }
    }
    return out;
  } catch (err) {
    logger.debug({ err, chatId }, 'getGateHistory failed (non-critical)');
    return [];
  }
}

function formatRelativeTime(deltaMs: number): string {
  const sec = Math.max(1, Math.round(deltaMs / 1000));
  if (sec < 60) return `${sec}秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}分钟前`;
  return `${Math.round(min / 60)}小时前`;
}

/** 渲染 [最近节奏决策] 块(新→旧,相对时间);空历史 → undefined。纯函数可测。 */
export function formatGateHistoryBlock(
  entries: GateHistEntry[],
  nowMs: number = Date.now(),
): string | undefined {
  if (entries.length === 0) return undefined;
  const lines = entries.map((en) => {
    const when = formatRelativeTime(nowMs - en.ts);
    const act = en.action === 'wait' && en.waitSec ? `wait(${en.waitSec}s)` : en.action;
    const why = en.reason ? `:「${en.reason.slice(0, 60)}」` : '';
    return `- ${when} ${act}${why}`;
  });
  return `[最近节奏决策] 你最近对这个群做过的节奏判断(新→旧):\n${lines.join('\n')}`;
}
