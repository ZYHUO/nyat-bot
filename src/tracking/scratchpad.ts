// ────────────────────────────────────────
// Scratchpad — 工作记忆 (AGI Level 5 P5-B)
//
// context window 一滚就忘的「即时意图」有了落脚处：
// 主人说「等下我发个文件你帮我看看」→ bot 写下 scratch「在等主人的文件」，
// 接下来 30 分钟里每次回复都带着这个认知，而不是文件来了当成孤立消息。
//
// 写入：CodeAct host-api（runtime.setScratch/clearScratch）+ heart verdict scratch 字段
// 读取：prompt-builder 注入（[正在惦记着] 块）+ CodeAct prompt
// 存储：Redis per-chat，TTL 30 分钟自然过期——工作记忆本来就是易失的。
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { logger } from '../shared/logger.js';

const KEY_PREFIX = 'xxb:scratch:';
const TTL_SEC = 30 * 60;
const MAX_ITEMS = 4;

export interface ScratchItem {
  text: string;
  at: number; // epoch sec
}

function key(chatId: number): string {
  return `${KEY_PREFIX}${chatId}`;
}

// 进程内缓存：buildMessages 是同步函数（prompt 缓存稳定契约），不能 await Redis。
// 写入路径（host-api setScratch/clearScratch，async）同步刷新缓存；读取先进程内、
// 进程重启后由 warmScratchCache 在读取前异步回填。丢失缓存 = 丢 30min 内的工作
// 记忆——可接受的易失语义。
const memCache = new Map<number, ScratchItem[]>();

/** 同步读（prompt 注入用）。只看进程内缓存。 */
export function getScratchSync(chatId: number): ScratchItem[] {
  return memCache.get(chatId)?.slice(0, MAX_ITEMS) ?? [];
}

/** 同步格式化成 prompt 块。空则返回 null。 */
export function scratchPromptBlockSync(chatId: number): string | null {
  const items = getScratchSync(chatId);
  if (!items.length) return null;
  const lines = items.map((i) => `- ${i.text}`).join('\n');
  return `[正在惦记着]\n${lines}\n这些是你刚才记下的事（比如答应了谁什么、在等什么）。相关就自然照应，没相关就当背景，别提起「记了笔记」这件事本身。`;
}

/** 进程重启后回填缓存（bookkeeping/executor 开头 fire-and-forget 调用）。 */
export async function warmScratchCache(chatId: number): Promise<void> {
  try {
    const raw = await getRedis().get(key(chatId));
    if (!raw) return;
    const items = JSON.parse(raw) as ScratchItem[];
    if (Array.isArray(items) && items.length) {
      memCache.set(chatId, items.slice(-MAX_ITEMS));
    }
  } catch { /* non-critical */ }
}

/** 读当前 scratch（async 路径用，Redis 为准）。 */
export async function getScratch(chatId: number): Promise<ScratchItem[]> {
  try {
    const raw = await getRedis().get(key(chatId));
    if (!raw) return [];
    const items = JSON.parse(raw) as ScratchItem[];
    return Array.isArray(items) ? items.slice(0, MAX_ITEMS) : [];
  } catch {
    return [];
  }
}

/** 写一条 scratch（覆盖同前缀旧条目，最多 MAX_ITEMS 条，FIFO）。 */
export async function setScratch(chatId: number, text: string): Promise<void> {
  const t = text.trim().slice(0, 120);
  if (!t) return;
  try {
    const redis = getRedis();
    const items = await getScratch(chatId);
    // 不做自动去重——中文字符前缀粒度无解（6 字太粗、12 字太细）。
    // 同义更新交给模型自己 clearScratch 再 set；FIFO 自然淘汰旧的。
    items.push({ text: t, at: Math.floor(Date.now() / 1000) });
    const trimmed = items.slice(-MAX_ITEMS);
    await redis.set(key(chatId), JSON.stringify(trimmed), 'EX', TTL_SEC);
    memCache.set(chatId, trimmed);
    logger.debug({ chatId, text: t }, 'scratch set');
  } catch (err) {
    logger.debug({ err, chatId }, 'setScratch failed (non-fatal)');
  }
}

/** 清掉匹配前缀的 scratch（事办完了）。空前缀 = 全清。 */
export async function clearScratch(chatId: number, prefix?: string): Promise<void> {
  try {
    const redis = getRedis();
    if (!prefix) {
      await redis.del(key(chatId));
      memCache.delete(chatId);
      return;
    }
    const items = await getScratch(chatId);
    const kept = items.filter((i) => !i.text.startsWith(prefix.slice(0, 6)));
    if (kept.length) {
      await redis.set(key(chatId), JSON.stringify(kept), 'EX', TTL_SEC);
      memCache.set(chatId, kept);
    } else {
      await redis.del(key(chatId));
      memCache.delete(chatId);
    }
  } catch (err) {
    logger.debug({ err, chatId }, 'clearScratch failed (non-fatal)');
  }
}
