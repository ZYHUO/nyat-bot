// ────────────────────────────────────────
// Skill Distill — 每 6h 小技能蒸馏 (AGI 自我 skill 系统)
//
// 定期读最近几小时的 episodes + experience_entries,LLM 提炼成
// 一个「小 skill」(触发条件/步骤/坑),落 skills 表。区别于 distiller
// 的碎片经验:skill 是结构化能力单元,可被 executor 检索复用。
// 蒸馏失败静默,下个周期再来——skill 是慢变量,不急这一轮。
// ────────────────────────────────────────

import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { loadCachedPrompt } from '../shared/config.js';
import { getDb } from '../db/sqlite.js';
import { saveSkill } from '../agent/skills.js';

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
    const eps = db
      .prepare(`SELECT goal, outcome, summary FROM episodes WHERE created_at > ? ORDER BY created_at DESC LIMIT 20`)
      .all(since) as { goal: string; outcome: string; summary: string }[];
    if (eps.length) {
      parts.push(
        '=== 最近任务 ===\n' +
          eps.map((e) => `- [${e.outcome}] ${e.goal.slice(0, 80)}\n  ${e.summary.slice(0, 200)}`).join('\n'),
      );
    }
    const exps = db
      .prepare(`SELECT kind, content FROM experience_entries WHERE created_at > ? ORDER BY created_at DESC LIMIT 30`)
      .all(since) as { kind: string; content: string }[];
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

    const id = saveSkill({
      name: skill.name,
      tier: 'small',
      triggerWhen: skill.trigger_when,
      steps: skill.steps,
      pitfalls: skill.pitfalls || undefined,
      summary: skill.summary || undefined,
      tags: skill.tags,
    });
    logger.info({ id, name: skill.name }, 'skill-distill: skill saved');
  } catch (err) {
    logger.warn({ err }, 'runSkillDistill failed');
  }
}
