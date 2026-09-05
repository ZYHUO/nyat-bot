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
export function parseDistillOutput(raw: string): DistillResult | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
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
      maxTokens: 1200,
      temperature: 0.3,
      allowHedge: false, // fire-and-forget 复盘:hedge 双发纯翻倍账单
    });

    const parsed = parseDistillOutput(res.content ?? '');
    if (!parsed) {
      logger.warn({ taskId: task.id }, 'distill output unparseable — skipping episode');
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
      saveExperienceEntries(
        parsed.experience.map((e) => ({
          kind: e.kind,
          content: e.content,
          tags: e.tags,
          sourceEpisodeId: episodeId,
          originBot: env().BOT_USERNAME ?? 'self',
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
