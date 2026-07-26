// ────────────────────────────────────────
// CodeAct 的「相关往事」段 —— 把长期记忆接进真正生成话语的那一层
// ────────────────────────────────────────
// 背景:Meta 编排器不自动注入记忆,CodeAct 也不 —— 只有模型主动调回忆工具时才查。
// 但真正说话的是 CodeAct(executor.ts),所以记忆该接在这里。
//
// **为什么不接 Meta**(评审结论,记下来免得后人再走一遍):Meta 的引擎是跨所有会话的
// 全局单例,它的输出会被 extractDigest 提取进全局 digest、落 Redis、再喂给梦境日记
// cron,而日记被注入到**每一个群**的 CodeAct prompt。私聊记忆进了 Meta prompt,
// 就有一条 "digest/日记 → 别的群" 的洗白路径 —— 与那次"私聊原文被念到群里"的事故
// 同源。CodeAct 这一层是 getContextEngine(`subagent:${chatId}`) 按会话独立、任务
// 也按会话,输出只发给那个会话,结构上没有这条路。
//
// 隐私硬守卫不在本文件 —— 在 memory/chroma.ts 的 searchMemoryForInjection 里,
// 那是唯一出口,调用方绕不过去(C-2 事故复盘的结论)。本文件只负责渲染与预算。

import { env } from '../env.js';
import { logger } from '../shared/logger.js';

/** 单条渲染后的最大字符数。 */
const LINE_CHARS = 100;
/** 引用计数节流窗口 —— CodeAct 可能在短时间内多次触发,别把同一批记忆刷成高频引用。 */
const REF_THROTTLE_MS = 10 * 60 * 1000;
const REF_CACHE_MAX = 2000;

/** mid → 上次记账时刻。用 Map + 有序淘汰(不整表 clear,否则解除节流会造成惊群)。 */
const _lastRefAt = new Map<string, number>();

function shouldRecordRef(mid: string, now: number): boolean {
  const prev = _lastRefAt.get(mid);
  if (prev !== undefined && now - prev < REF_THROTTLE_MS) return false;
  _lastRefAt.set(mid, now);
  // 超限时按插入序淘汰最旧的一批,而不是整表清空 —— 整表清空会让下一 tick
  // 对所有命中重新记账,正好在想保护的那个计数器上制造惊群。
  if (_lastRefAt.size > REF_CACHE_MAX) {
    const excess = _lastRefAt.size - REF_CACHE_MAX;
    let i = 0;
    for (const k of _lastRefAt.keys()) {
      if (i++ >= excess) break;
      _lastRefAt.delete(k);
    }
  }
  return true;
}

/**
 * 行内化 —— 语义同 pipeline/context/slim.ts。
 * 记忆正文是**用户产生的内容**,直接拼进 prompt 等于把 prompt 的结构交给用户控制:
 * 换行可以伪造新的段落标题,`#123` 会被 CodeAct 当成可引用的 messageId(executor.ts
 * 的 replyTo 约束就是按 `#\d+` 认的),控制字符能制造不可见的分隔。
 */
function inlineForPrompt(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ⏎ ')                       // 换行:伪造段落/标题
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')  // 控制字符:不可见的结构伪造
    .replace(/#(\d)/g, '＃$1')                        // #123 → ＃123:防被当成 quote 目标
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LINE_CHARS);
}

/** UTC 时间戳 → MM-DD,给模型一点时间感,但不暴露完整日期。 */
function shortDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface MemoryContextInput {
  chatId: number;
  /** 检索查询 —— 通常是本轮要回的那句话 + 任务方向。 */
  query: string;
  /** 已在「最近聊天」里出现过的 messageId,避免同一条消息在 prompt 里出现两次。 */
  excludeMessageIds?: ReadonlySet<number>;
}

/** 灰度判定。**空列表 = 关闭**,与仓库其他 flag 的「空 = 全量」刻意相反 —— */
/** 这是隐私相关特性,配错的代价是不对称的:漏开只是没效果,误开是内容外泄。 */
function isEnabledForChat(chatId: number): boolean {
  const e = env();
  if (!e.SUBAGENT_MEMORY_ENABLED) return false;
  const list = e.SUBAGENT_MEMORY_CHAT_IDS;
  return list.length > 0 && list.includes(chatId);
}

/**
 * 构建「相关往事」段。**永不抛、永不阻塞**:任何异常或超时都返回空串,
 * CodeAct 照常运行,只是这一段是空的。
 */
export async function buildSubagentMemoryBlock(input: MemoryContextInput): Promise<string> {
  try {
    // env() 也在 try 内 —— zod 解析异常若逃出去会冒泡进 executor,
    // 而那是生产热路径上一个"记忆功能"绝不该有的权力。
    if (!isEnabledForChat(input.chatId)) return '';
    if (!input.query.trim()) return '';

    const timeoutMs = env().SUBAGENT_MEMORY_TIMEOUT_MS;
    // 超时后必须让底下的副作用**闭嘴**:Promise.race 不取消,若不加这个标志,
    // 超时返回空串之后 recordRefs 仍会给「从没进过 prompt」的记忆刷引用计数,
    // 而引用计数正是遗忘 cron 的唯一判据 —— 等于一边保护记忆一边污染它。
    let timedOut = false;
    const timer = new Promise<string>((resolve) => {
      const t = setTimeout(() => { timedOut = true; resolve(''); }, timeoutMs);
      if (t.unref) t.unref();
    });
    return await Promise.race([buildInner(input, () => timedOut), timer]);
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'subagent memory block failed (non-critical)');
    return '';
  }
}

async function buildInner(input: MemoryContextInput, isTimedOut: () => boolean): Promise<string> {
  const { chatId, query, excludeMessageIds } = input;
  const e = env();

  const { searchMemoryForInjection } = await import('../memory/chroma.js');
  // 内层超时留出余量,让 searchMemory 自己先返回,而不是被外层竞速切掉。
  const hits = await searchMemoryForInjection(
    chatId, query, e.SUBAGENT_MEMORY_TOPK, Math.max(50, e.SUBAGENT_MEMORY_TIMEOUT_MS - 50),
  );
  if (isTimedOut() || hits.length === 0) return '';

  const kept = hits.filter((m) => {
    // bot 自己说过的话不算"往事" —— 它已经在「最近聊天」里,重复注入会诱发复读。
    if (m.role === 'assistant') return false;
    // 已在最近聊天里出现过的,不重复贴。
    if (excludeMessageIds?.has(m.messageId)) return false;
    return Boolean(m.textContent?.trim());
  });
  if (kept.length === 0) return '';

  // 逐行累加到预算为止 —— 不在拼好之后尾部 slice,那样最后一条永远被切成半句碎片。
  const budget = e.SUBAGENT_MEMORY_MAX_CHARS;
  const lines: string[] = [];
  const usedMids: string[] = [];
  let used = 0;
  for (const m of kept) {
    const who = m.username ? `@${m.username}` : (m.fullName || `uid:${m.uid}`);
    const line = `- [${shortDate(m.timestamp)}] ${who}: ${inlineForPrompt(m.textContent)}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
    usedMids.push(`${m.sourceChatId ?? chatId}_${m.messageId}`);
  }
  if (lines.length === 0) return '';

  // 记账放在最后,且要再查一次超时:走到这里可能已经过了外层的 race。
  if (!isTimedOut() && usedMids.length > 0) {
    const now = Date.now();
    const fresh = usedMids.filter((mid) => shouldRecordRef(mid, now));
    if (fresh.length > 0) {
      // fire-and-forget:记账失败不影响这一段已经建好的内容。
      import('../memory/importance.js')
        .then(({ recordMemoryReferenced }) => recordMemoryReferenced(fresh))
        .catch(() => { /* non-critical */ });
    }
  }

  // 日志只记数量,**绝不记正文** —— 这一段的内容按定义是可能敏感的。
  logger.info({ chatId, hits: hits.length, kept: lines.length, chars: used }, 'subagent memory injected');
  return lines.join('\n');
}
