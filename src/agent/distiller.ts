// ────────────────────────────────────────
// Experience Distiller — 任务终态复盘蒸馏 (AGI Level 4 P4-A)
//
// CodeAct 任务真正终态（done/failed，不含 resumed_seg* 续跑段）时
// fire-and-forget 触发：LLM 读目标+结果+尾部执行片段 → 严格 JSON 输出
// 一段 episode + 0~3 条可复用经验。复盘失败静默 warn，不重试不炸主流程
// —— 复盘是锦上添花，不值得烧重试预算。
// ────────────────────────────────────────

import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { loadCachedPrompt } from '../shared/config.js';
import { saveEpisode, saveExperienceEntries, pruneExperience } from './episodes.js';
import type { DispatchTask } from '../meta/types.js';

export interface DistillResult {
  summary: string;
  lessons: string[];
  tags: string[];
  experience: { kind: string; content: string; tags: string[] }[];
  /** P4-B 预留：这次任务发现值得持续关注的事（goal 主题）。 */
  followUpGoal: string | null;
}

/** 解析 LLM 输出为 DistillResult；垃圾输出返回 null（不重试）。 */
/**
 * 把被 max_tokens 截断的 JSON 修到能解析：按栈补上未闭合的 `"`、`[`、`{`。
 *
 * 只在原样解析失败之后才会被尝试（见 candidates 最后一项），所以正常输出
 * 走不到这里。修得好就救回一条 episode，修不好返回 ''（候选为空，跳过）。
 */
function repairTruncatedJson(raw: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of raw) {
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[' || ch === '{') stack.push(ch);
    else if ((ch === ']' || ch === '}') && stack.length) stack.pop();
  }
  let out = raw;
  if (inStr) out += '"';                       // 字符串写到一半
  while (stack.length) {                       // 数组/对象没关
    const open = stack.pop()!;
    out += open === '[' ? ']' : '}';
  }
  return out;
}

export function parseDistillOutput(raw: string): DistillResult | null {
  try {
    // **先剥围栏，再找 JSON。** 2026-09-21 实测生产里最新一条失败（len=655）的
    // 原文开头是 `{```json`——模型先吐了一个孤零零的 `{`，然后才开围栏写 JSON。
    // 原来的 `/^```(?:json)?\s*/i` 只剥**行首**的围栏，前面多一个字符就整个失效，
    // 于是这条既没剥掉围栏、也匹配不到完整的 `{...}`，直接判失败。
    //
    // 近 24h distill 失败 360 次，带 len/head 的 26 条里能看到这种形状。
    // 剥离改成： anywhere 的 ```json / ``` 都去，然后再 trim。
    const cleaned = raw
      .replace(/```(?:json)?/gi, ' ')
      .trim();
    // 再丢掉 JSON 之前的散落字符。生产实测那条是 `{```json` → 剥完围栏变成
    // `{ {  "summary": …`——**两个连续的花括号**。JSON.parse 不认这种：
    // 外层对象的 key 不能是 `{`。截断自救也救不了它（补完括号还是 `{ {...}}`）。
    // 所以从第一个 `{"` / `{ "` 开始切，前面的一律当模型的口头禅丢掉。
    const objStart = cleaned.match(/\{\s*"/);
    if (objStart && objStart.index !== undefined && objStart.index > 0) {
      return parseFrom(objStart.index === 0 ? cleaned : cleaned.slice(objStart.index));
    }
    return parseFrom(cleaned);
  } catch (err) {
    logger.debug({ err }, 'parseDistillOutput threw');
    return null;
  }
}

/** 从一段（可能带前缀/围栏/截断的）文本里解析出 DistillResult。 */
function parseFrom(cleaned: string): DistillResult | null {
  try {
    const candidates = [
      cleaned,
      cleaned.replace(/,\s*([}\]])/g, '$1'),
      cleaned.match(/\{[\s\S]*\}/)?.[0] ?? '',
      (cleaned.match(/\{[\s\S]*\}/)?.[0] ?? '').replace(/,\s*([}\]])/g, '$1'),
      // 截断自救：模型写到一半被 max_tokens 切断时，把开着的引号/数组/对象补齐再解析。
      // 上面的四个候选都要求有收尾的 `}`，截断输出一个都过不了——于是 1287 次
      // 里带 len/head 的那 14 条全是这个形状。补一条"闭合后重试"的候选，
      // 让"summary 已经拿到、lessons 只写了一半"这种情况也能留下记录。
      repairTruncatedJson(cleaned),
    ];
    let obj: Record<string, unknown> | null = null;
    for (const candidate of candidates) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          obj = parsed as Record<string, unknown>;
          break;
        }
      } catch {
        // Try the next common LLM formatting variant.
      }
    }
    if (!obj) return null;
    const summary = typeof obj['summary'] === 'string' ? (obj['summary'] as string).trim().slice(0, 2000) : '';
    if (!summary) return null;
    const strArr = (v: unknown, max: number, len: number): string[] =>
      Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, len)).slice(0, max) : [];
    const experience = Array.isArray(obj['experience'])
      ? (obj['experience'] as unknown[])
          .map((e) => {
            if (typeof e !== 'object' || e === null) return null;
            const eo = e as Record<string, unknown>;
            const content = typeof eo['content'] === 'string' ? eo['content'].trim().slice(0, 500) : '';
            if (!content) return null;
            const kindRaw = typeof eo['kind'] === 'string' ? eo['kind'] : 'trick';
            const kind = ['pitfall', 'trick', 'preference'].includes(kindRaw) ? kindRaw : 'trick';
            return { kind, content, tags: strArr(eo['tags'], 4, 40) };
          })
          .filter((e): e is { kind: string; content: string; tags: string[] } => e !== null)
          .slice(0, 3)
      : [];
    const followUpGoal =
      typeof obj['follow_up_goal'] === 'string' && (obj['follow_up_goal'] as string).trim().length >= 4
        ? (obj['follow_up_goal'] as string).trim().slice(0, 100)
        : null;
    return {
      summary,
      lessons: strArr(obj['lessons'], 3, 200),
      tags: strArr(obj['tags'], 8, 40),
      experience,
      followUpGoal,
    };
  } catch {
    return null;
  }
}

export interface DistillEpisodeArgs {
  task: DispatchTask;
  outcome: 'done' | 'failed';
  progressSummary: string;
  /** 尾部执行片段（最后 N 轮序列化，≤3000 字符）。 */
  tailText: string;
}

/**
 * 复盘一个终态任务：LLM 蒸馏 → episode + experience 落库 → 淘汰超额经验。
 * 返回 DistillResult（含 followUpGoal 供 P4-B goal 钩子使用），失败返回 null。
 */
export async function distillEpisode(args: DistillEpisodeArgs): Promise<DistillResult | null> {
  const { task, outcome, progressSummary, tailText } = args;
  // Evidence gate: lifecycle done without host verification must not be distilled as success.
  const assessed: 'done' | 'failed' =
    outcome === 'done' && task.assessment?.status === 'verified' ? 'done' : 'failed';
  try {
    const system = loadCachedPrompt('task/distill.md');
    const user = [
      `goal: ${task.contentDirection.slice(0, 500)}`,
      `outcome: ${assessed}`,
      `summary: ${progressSummary.slice(0, 2000)}`,
      `turns: ${task.totalTurns ?? 0}, segments: ${(task.segment ?? 0) + 1}`,
      ``,
      `tail:`,
      tailText.slice(0, 3000),
    ].join('\n');

    const res = await callWithFallback({
      usage: env().DISTILL_USAGE,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      // 1200 → 3000。2026-09-21 实测：`distill output unparseable` 1287 次，
      // 带原始输出的 14 条 len 分别是 61/85/112/172/183/236/262/267/283/457/477/605/688/911
      // ——**全是 JSON 被从中间截断**（`{"summary": "本次任务要求…禁止复读原话` 就没了）。
      // 模型输出形状一直是对的，是额度不够写完。
      //
      // 为什么 provider 层的截断重试没救它：`callModel` 只在 `!finalText`
      // （正文全空）时才加额重试。这里正文非空、只是 JSON 不完整， provider 层
      // 看不出问题，重试从不触发。这是 round 12（topic-scan 24）和 round 40
      // （post-task 200）同一条病的第三例，但形状不同：前两例是"空正文"，
      // 这例是"半个 JSON"。
      maxTokens: 3000,
      temperature: 0.3,
      allowHedge: false, // fire-and-forget 复盘:hedge 双发纯翻倍账单
    });

    const parsed = parseDistillOutput(res.content ?? '');
    if (!parsed) {
      // 同上：2026-09-21 之前不带原始输出，473 次失败查不出形状。
      logger.warn(
        { taskId: task.id, len: (res.content ?? '').length, head: (res.content ?? '').slice(0, 300) },
        'distill output unparseable — skipping episode',
      );
      return null;
    }

    // AGI L5 L1: 过滤实例级经验 —— 含具体人名/单次事件痕迹的降级为抽象版。
    // (prompt 已要求原则级,这里是兜底:实例级经验宁可 drop 也不污染库)
    const PRINCIPLE_VIOLATION = /(小明|小红|老王|上次|刚才|这次任务|群友\w*|【[^】]+】|#\d+)/;
    parsed.experience = parsed.experience.filter((e) => {
      const dirty = PRINCIPLE_VIOLATION.test(e.content) && e.content.length <= 120;
      if (dirty) {
        logger.debug({ taskId: task.id, content: e.content }, 'dropped instance-level experience (L1)');
      }
      return !dirty;
    });

    const episodeId = saveEpisode({
      taskId: task.id,
      chatId: task.chatId,
      goal: task.contentDirection,
      outcome: assessed,
      summary: parsed.summary,
      lessons: parsed.lessons,
      tags: parsed.tags,
      turns: task.totalTurns ?? 0,
      segments: (task.segment ?? 0) + 1,
    });

    if (episodeId !== null && parsed.experience.length > 0) {
      // P3-1 血缘:记录产出 episode 的 assessed outcome + host assessment。
      // skill-distill 只读 source_assessment='verified' 的经验 —— unverified 经验
      // 仍保留在库(可检索),但永不进入技能蒸馏素材。
      const srcAssessment = task.assessment?.status ?? 'unverified';
      saveExperienceEntries(
        parsed.experience.map((e) => ({
          kind: e.kind,
          content: e.content,
          tags: e.tags,
          sourceEpisodeId: episodeId,
          originBot: env().BOT_USERNAME ?? 'self',
          sourceOutcome: assessed,
          sourceAssessment: srcAssessment === 'verified' ? 'verified' : srcAssessment === 'failed' ? 'failed' : 'unverified',
        })),
      );
      pruneExperience(200);
    }

    logger.info(
      { taskId: task.id, episodeId, experienceCount: parsed.experience.length, followUpGoal: parsed.followUpGoal },
      'episode distilled',
    );
    return parsed;
  } catch (err) {
    logger.warn({ err, taskId: task.id }, 'episode distill failed');
    return null;
  }
}
