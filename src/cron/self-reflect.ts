// ────────────────────────────────────────
// Self-Reflect — 每日自我复盘 (AGI Level 4 P4-C)
//
// 凌晨低峰跑一次：取最近 24h 主人 DM + 最活跃群的回复样本 + 近期任务
// 统计 → judge LLM 复盘 → ≤5 条可操作自我认知落库 → 注入回复 prompt。
// 复盘失败静默，明天再来——self-model 是慢变量，不急这一天。
// ────────────────────────────────────────

import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { loadCachedPrompt } from '../shared/config.js';
import { getRecent } from '../pipeline/context/manager.js';
import { getRedis } from '../db/redis.js';
import { getDb } from '../db/sqlite.js';
import { saveSelfNotes, pruneSelfNotes } from '../tracking/self-model.js';
import type { FormattedMessage } from '../shared/types.js';

/** 解析 reflector 输出；垃圾返回 null。 */
export function parseSelfReflectOutput(raw: string): { note: string; evidence: string }[] | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    if (!Array.isArray(obj['notes'])) return null;
    return (obj['notes'] as unknown[])
      .map((n) => {
        if (typeof n !== 'object' || n === null) return null;
        const no = n as Record<string, unknown>;
        const note = typeof no['note'] === 'string' ? no['note'].trim().slice(0, 300) : '';
        if (note.length < 4) return null;
        const evidence = typeof no['evidence'] === 'string' ? no['evidence'].trim().slice(0, 500) : '';
        return { note, evidence };
      })
      .filter((n): n is { note: string; evidence: string } => n !== null)
      .slice(0, 5);
  } catch {
    return null;
  }
}

/** 近期任务统计（episodes，P4-A 的表；表可能不存在则容忍）。 */
function recentEpisodeStats(): string {
  try {
    const rows = getDb()
      .prepare(
        `SELECT outcome, COUNT(*) AS c FROM episodes
         WHERE created_at > ? GROUP BY outcome`,
      )
      .all(Math.floor(Date.now() / 1000) - 7 * 86400) as { outcome: string; c: number }[];
    if (!rows.length) return '最近 7 天没有记录的任务。';
    return rows.map((r) => `${r.outcome}: ${r.c} 个`).join('，');
  } catch {
    return '任务统计不可用。';
  }
}

/** 格式化样本：每条一行，标注是 bot 还是人类说的。 */
function formatSamples(msgs: FormattedMessage[], max: number): string {
  return msgs
    .slice(-max)
    .map((m) => `${m.role === 'assistant' ? '[bot]' : `[人:${m.uid}]`} ${(m.textContent ?? '').slice(0, 200)}`)
    .filter((l) => l.length > 12)
    .join('\n');
}

/** 最近 24h 有活动的群（复用 sleep-cycle 的 zset 源，最活跃的排前）。 */
async function activeGroups24h(): Promise<number[]> {
  try {
    const raw = await getRedis().zrange('xxb:active_groups', 0, -1);
    return raw.map(Number).filter((n) => !Number.isNaN(n) && n < 0).slice(0, 5);
  } catch {
    return [];
  }
}

export async function runSelfReflect(): Promise<void> {
  try {
    const masterUid = env().MASTER_UID;
    const groups = await activeGroups24h();

    const samples: string[] = [];
    // 主人 DM 样本（最权威的表现观察窗口）
    if (masterUid > 0) {
      const dm = await getRecent(masterUid, 30).catch(() => []);
      const dmText = formatSamples(dm, 20);
      if (dmText) samples.push(`=== 与主人的私聊（最近）===\n${dmText}`);
    }
    // 最活跃群样本
    const topGroup = groups[0];
    if (topGroup) {
      const g = await getRecent(topGroup, 40).catch(() => []);
      const gText = formatSamples(g, 20);
      if (gText) samples.push(`=== 最活跃群（最近）===\n${gText}`);
    }

    if (!samples.length) {
      logger.info('self-reflect: no samples, skip');
      return;
    }

    const system = loadCachedPrompt('task/self-reflect.md');
    // Phase 14.4: 谄媚审计趋势当证据(有则拼,无则跳过;确定性,不烧 token)。
    let sycoLine = '';
    try {
      if (env().SYCOPHANCY_AUDIT_ENABLED) {
        const { recentSycoTrend } = await import('./sycophancy-audit.js');
        sycoLine = recentSycoTrend() ?? '';
      }
    } catch { /* non-critical */ }
    const res = await callWithFallback({
      usage: env().SELF_REFLECT_USAGE,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `最近 7 天任务统计：${recentEpisodeStats()}\n\n${samples.join('\n\n')}${sycoLine ? `\n\n${sycoLine}` : ''}\n\n复盘这些表现，给出 0-5 条可操作的自我调整。`,
        },
      ],
      maxTokens: 1000,
      temperature: 0.4,
    });

    const notes = parseSelfReflectOutput(res.content ?? '');
    if (notes === null) {
      logger.warn('self-reflect: output unparseable — skip');
      return;
    }
    if (notes.length === 0) {
      logger.info('self-reflect: model decided nothing needs adjusting');
      return;
    }

    const saved = saveSelfNotes(notes);
    pruneSelfNotes(20);
    logger.info({ saved, total: notes.length }, 'self-reflect: notes saved');
  } catch (err) {
    logger.warn({ err }, 'runSelfReflect failed');
  }
}
