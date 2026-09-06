// ────────────────────────────────────────
// Skill Distill — 每 6h 小技能蒸馏 (AGI 自我 skill 系统)
//
// 定期读最近几小时的 episodes + experience_entries,LLM 提炼成
// 一个「小 skill」(触发条件/步骤/坑)。
// Phase 7 起不再直写 skills 表 —— 走 core lifecycle 门
// （propose → verify → 主人 approve → publish），直写口子已封。
// 蒸馏失败静默,下个周期再来——skill 是慢变量,不急这一轮。
// ────────────────────────────────────────

import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { loadCachedPrompt } from '../shared/config.js';
import { getDb } from '../db/sqlite.js';

export interface DistilledSkill {
  name: string;
  trigger_when: string;
  steps: string;
  pitfalls: string;
  summary: string;
  tags: string[];
}

/** 解析 skill-distill 输出;垃圾或 null 返回 null。 */
export function parseSkillDistillOutput(raw: string): DistilledSkill | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (cleaned === 'null' || cleaned === '') return null;
  try {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    const name = typeof obj['name'] === 'string' ? obj['name'].trim().slice(0, 80) : '';
    const triggerWhen = typeof obj['trigger_when'] === 'string' ? obj['trigger_when'].trim().slice(0, 500) : '';
    const steps = typeof obj['steps'] === 'string' ? obj['steps'].trim().slice(0, 2000) : '';
    if (!name || !triggerWhen || !steps) return null;
    const pitfalls = typeof obj['pitfalls'] === 'string' ? obj['pitfalls'].trim().slice(0, 1000) : '';
    const summary = typeof obj['summary'] === 'string' ? obj['summary'].trim().slice(0, 300) : '';
    const tags = Array.isArray(obj['tags'])
      ? (obj['tags'] as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 40)).slice(0, 4)
      : [];
    return { name, trigger_when: triggerWhen, steps, pitfalls, summary, tags };
  } catch {
    return null;
  }
}

/** 最近窗口的 episode 摘要 + 经验条目,拼成蒸馏素材。 */
function recentMaterial(windowSec: number): string {
  const since = Math.floor(Date.now() / 1000) - windowSec;
  const parts: string[] = [];
  try {
    const db = getDb();
    // Evidence gate: only episodes with host-verified task_evidence may seed skills.
    // Rows without evidence (old data) are treated as unverified and excluded.
    let eps: { goal: string; outcome: string; summary: string }[] = [];
    try {
      eps = db
        .prepare(`SELECT e.goal, e.outcome, e.summary FROM episodes e
           JOIN task_evidence t ON t.task_id = e.task_id AND t.assessment = 'verified'
           WHERE e.created_at > ? ORDER BY e.created_at DESC LIMIT 20`)
        .all(since) as { goal: string; outcome: string; summary: string }[];
    } catch {
      eps = [];
    }
    if (eps.length) {
      parts.push(
        '=== 最近任务 ===\n' +
          eps.map((e) => `- [${e.outcome}] ${e.goal.slice(0, 80)}\n  ${e.summary.slice(0, 200)}`).join('\n'),
      );
    }
    // P3-1: experience_entries 只读 verified 血缘。历史数据(无血缘列或
    // source_assessment != 'verified')一律排除 —— 未验证的经验不进技能素材。
    let exps: { kind: string; content: string }[] = [];
    try {
      exps = db
        .prepare(
          `SELECT kind, content FROM experience_entries
           WHERE created_at > ? AND source_assessment = 'verified'
           ORDER BY created_at DESC LIMIT 30`,
        )
        .all(since) as { kind: string; content: string }[];
    } catch {
      // 0075 未应用的库(无血缘列):fail-closed,经验素材为空而非回退全量。
      exps = [];
    }
    if (exps.length) {
      parts.push('=== 最近经验 ===\n' + exps.map((e) => `- (${e.kind}) ${e.content}`).join('\n'));
    }
  } catch (err) {
    logger.warn({ err }, 'skill-distill: material query failed');
  }
  return parts.join('\n\n');
}

export async function runSkillDistill(): Promise<void> {
  try {
    const windowSec = env().SKILL_DISTILL_INTERVAL_MIN * 60;
    const material = recentMaterial(windowSec);
    if (!material.trim()) {
      logger.info('skill-distill: no material, skip');
      return;
    }

    const system = loadCachedPrompt('task/skill-distill.md');
    const res = await callWithFallback({
      usage: env().SKILL_DISTILL_USAGE,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: material },
      ],
      maxTokens: 1200,
      temperature: 0.3,
      allowHedge: false,
    });

    const skill = parseSkillDistillOutput(res.content ?? '');
    if (skill === null) {
      logger.info('skill-distill: nothing worth distilling (null) or unparseable');
      return;
    }

    // Phase 7：走 lifecycle 门（propose → verify，再等主人 approve/publish）。
    // verify 当场跑（确定性红线扫描），进了 verified 就在 /skill pending 里等主人。
    const { proposeSkill, verifySkill } = await import('../core/skills/lifecycle.js');
    const lid = proposeSkill({
      name: skill.name,
      triggerWhen: skill.trigger_when,
      steps: skill.steps,
      pitfalls: skill.pitfalls || undefined,
      summary: skill.summary || undefined,
      tags: skill.tags,
    });
    const v = verifySkill(lid);
    logger.info({ lid, name: skill.name, verified: v.ok, reason: v.reason }, 'skill-distill: proposed to lifecycle gate');
  } catch (err) {
    logger.warn({ err }, 'runSkillDistill failed');
  }
}
