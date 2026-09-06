// ────────────────────────────────────────
// Skill Consolidate — 每周大技能回收 (AGI 自我 skill 系统)
//
// 每周读所有未归档的小 skill,LLM 合并去重成「大 skill」,被合并的
// 小 skill 归档(不再注入但保留历史)。大 skill 库超上限按 use_count
// 淘汰。这是「回收那一周的所有 skill 防止爆掉」的落点。
//
// Phase 7 起：大 skill 不再直写 skills 表 —— 走 lifecycle 门
// （propose → verify → 主人 approve → publish）；归档动作照旧
// （只碰 skills 表的 archived 位，不经过门）。
// ────────────────────────────────────────

import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { loadCachedPrompt } from '../shared/config.js';
import { archiveSkills, getRecentSmallSkills, pruneBigSkills } from '../agent/skills.js';

export interface ConsolidatedSkill {
  name: string;
  trigger_when: string;
  steps: string;
  pitfalls: string;
  summary: string;
  tags: string[];
  merged_from: string[];
}

/** 解析 skill-consolidate 输出;垃圾返回 null。 */
export function parseSkillConsolidateOutput(raw: string): ConsolidatedSkill[] | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    if (!Array.isArray(obj['skills'])) return null;
    return (obj['skills'] as unknown[])
      .map((s) => {
        if (typeof s !== 'object' || s === null) return null;
        const so = s as Record<string, unknown>;
        const name = typeof so['name'] === 'string' ? so['name'].trim().slice(0, 80) : '';
        const triggerWhen = typeof so['trigger_when'] === 'string' ? so['trigger_when'].trim().slice(0, 500) : '';
        const steps = typeof so['steps'] === 'string' ? so['steps'].trim().slice(0, 2000) : '';
        if (!name || !triggerWhen || !steps) return null;
        const pitfalls = typeof so['pitfalls'] === 'string' ? so['pitfalls'].trim().slice(0, 1000) : '';
        const summary = typeof so['summary'] === 'string' ? so['summary'].trim().slice(0, 300) : '';
        const tags = Array.isArray(so['tags'])
          ? (so['tags'] as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 40)).slice(0, 5)
          : [];
        const mergedFrom = Array.isArray(so['merged_from'])
          ? (so['merged_from'] as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().slice(0, 80))
          : [];
        return { name, trigger_when: triggerWhen, steps, pitfalls, summary, tags, merged_from: mergedFrom };
      })
      .filter((s): s is ConsolidatedSkill => s !== null);
  } catch {
    return null;
  }
}

export async function runSkillConsolidate(): Promise<void> {
  try {
    const smalls = getRecentSmallSkills(200);
    if (smalls.length === 0) {
      logger.info('skill-consolidate: no small skills, skip');
      return;
    }

    const material = smalls
      .map(
        (s) =>
          `### ${s.name}\n触发: ${s.triggerWhen}\n做法: ${s.steps}\n坑: ${s.pitfalls ?? ''}\n标签: ${s.tags.join(', ')}`,
      )
      .join('\n\n');

    const system = loadCachedPrompt('task/skill-consolidate.md');
    const res = await callWithFallback({
      usage: env().SKILL_CONSOLIDATE_USAGE,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: material },
      ],
      maxTokens: 2000,
      temperature: 0.3,
      allowHedge: false,
    });

    const consolidated = parseSkillConsolidateOutput(res.content ?? '');
    if (consolidated === null) {
      logger.warn('skill-consolidate: output unparseable — skip');
      return;
    }
    if (consolidated.length === 0) {
      logger.info('skill-consolidate: nothing to merge');
      return;
    }

    // 归档被合并的小 skill(按 name 精确匹配)。
    const nameToId = new Map(smalls.map((s) => [s.name, s.id]));
    const archivedIds: number[] = [];
    for (const c of consolidated) {
      for (const n of c.merged_from) {
        const id = nameToId.get(n);
        if (id !== undefined) archivedIds.push(id);
      }
    }
    archiveSkills(archivedIds);

    // Phase 7：大 skill 走 lifecycle 门。归档照旧（archived 位），落库改 propose+verify。
    // tier='big' + mergedFrom 进 proposal，主人 /skill show 可追溯，publish 时按 big 落库。
    const { proposeSkill, verifySkill } = await import('../core/skills/lifecycle.js');
    let proposed = 0;
    for (const c of consolidated) {
      const lid = proposeSkill({
        name: c.name,
        triggerWhen: c.trigger_when,
        steps: c.steps,
        pitfalls: c.pitfalls || undefined,
        summary: c.summary || undefined,
        tags: c.tags,
        tier: 'big',
        mergedFrom: c.merged_from,
      });
      const v = verifySkill(lid);
      if (v.ok) proposed++;
      else logger.info({ lid, name: c.name, reason: v.reason }, 'skill-consolidate: big proposal rejected by verify');
    }

    pruneBigSkills(env().SKILL_MAX_BIG);
    logger.info({ proposed, archived: archivedIds.length }, 'skill-consolidate: done');
  } catch (err) {
    logger.warn({ err }, 'runSkillConsolidate failed');
  }
}
