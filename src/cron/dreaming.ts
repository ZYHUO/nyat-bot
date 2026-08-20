// ────────────────────────────────────────
// Dreaming 做梦 (CGM background-agent 简化版, DREAMING_ENABLED 默认关)
//
// 凌晨 cron 触发:把「上次成功做梦以来」的素材(本周期 CodeAct 任务 /
// 高好感的人 / 全局 session digest / 活跃群)打包成 digest,派发**一个**
// 特权长 CodeAct 任务到主人 DM,让它夜里自主干活(查资料/准备小惊喜/写东西),
// 最后给主人留张字条(或安静收尾)。
//
// 与 dream-journal 互补:journal 是 LLM 写日记(感受向),dreaming 是
// CodeAct 自主行动(行动向)。素材层移植 CGM harness/dreaming-context.ts
// 的 buildDreamingDigest,精简到 nyat-bot 可查的数据源。
//
// 设计要点:
// - 全程 fail-soft:任何数据源失败降级为空段,不炸 cron;flag 关 → 直接 skip。
// - 并发护栏靠 SQLite dreaming_runs:有未完结且未 stale(>2h 视为死掉)的
//   running 行就不再起新 run;stale 行顺手标记 failed。
// - executor 不认识 [dreaming] marker(它的 [selfplay]/[goal] 才走专用
//   prompt),所以完整做梦 prompt 内联进 contentDirection 自包含下发 ——
//   不需要改 executor。注意:不能带 [selfplay] 字样,否则会被当成自玩
//   (host 层 maxTextSends=0,给主人的字条发不出去)。
// ────────────────────────────────────────

import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getDb } from '../db/sqlite.js';
import { getRedis } from '../db/redis.js';
import { getGlobalState } from '../meta/global-state.js';
import { enqueueCodeActJob } from '../subagent/queue.js';
import { loadCachedPrompt } from '../shared/config.js';
import type { DispatchTask } from '../meta/types.js';

/** running 行超过此时长视为进程死掉的残留,不再挡新 run。 */
export const DREAMING_STALE_SEC = 2 * 3600;
/** 做梦素材总字符上限(超出按「最旧的 digest → 最旧的任务 → 硬切」顺序裁剪)。 */
export const DREAMING_MAX_CONTEXT_CHARS = 4000;
/** 纳入素材的本周期任务上限(超出保留最新 N 条)。 */
const MAX_TASKS_IN_CONTEXT = 40;
/** 高好感人物上榜人数。 */
const TOP_PEOPLE_LIMIT = 8;
/** session digest 纳入条数。 */
const MAX_DIGESTS = 30;
/** 活跃群展示上限。 */
const MAX_GROUPS = 8;
/** 没有任何历史 run 时,素材窗口默认回看 24h。 */
const DEFAULT_WINDOW_SEC = 86400;

const TASKS_HASH = 'xxb:codeact:tasks';
const DIGESTS_LIST = 'xxb:meta:digests';
const ACTIVE_GROUPS_ZSET = 'xxb:active_groups';

export type DreamingRunStatus = 'done' | 'failed' | 'skipped';

export interface DreamingResult {
  status: DreamingRunStatus;
  reason: string;
  runId?: number;
  taskId?: string;
}

export interface DreamingContext {
  text: string;
  tasksReviewed: number;
}

/** prompts/task/dreaming.md 加载失败时的兜底(保持硬边界不丢)。 */
const FALLBACK_DREAMING_PROMPT = `# Dreaming 做梦时间（特权后台任务）

现在是凌晨，大家都睡了。读完下面的做梦素材，挑最多 3 件真正有意义的事
（查资料 / 准备小惊喜 / 写下想法），在沙盒里安静地做，产物写进文件。

硬边界：禁止给任何群发消息、禁止 @ 任何人、禁止逐一私聊群友；
telegram.sendText 唯一去处是当前主人私聊，且全程最多一两次（留张字条）；
禁止假装做过没做的事。最后必须 runtime.endTask("今晚做了什么")收尾。`;

interface RunRow {
  id: number;
  started_at: number;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function fmtTs(ms: number): string {
  return new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
}

// ── 素材源 (全部 best-effort) ─────────────────

/** 本周期 CodeAct 任务: Redis hash (durable) ∪ 进程内 global-state,按 id 去重。 */
async function collectTasks(sinceMs: number): Promise<DispatchTask[]> {
  const byId = new Map<string, DispatchTask>();
  try {
    const raw = await getRedis().hgetall(TASKS_HASH);
    for (const v of Object.values(raw)) {
      try {
        const t = JSON.parse(v) as DispatchTask;
        if (t && typeof t.id === 'string' && t.id) byId.set(t.id, t);
      } catch {
        /* 单行坏 JSON 跳过 */
      }
    }
  } catch (err) {
    logger.debug({ err }, 'dreaming: redis task hash unreadable');
  }
  try {
    // 进程内状态更新(终态 summary 最新),覆盖 redis 同 id 行。
    for (const t of getGlobalState().listTasks()) byId.set(t.id, t);
  } catch (err) {
    logger.debug({ err }, 'dreaming: global-state tasks unreadable');
  }
  return [...byId.values()]
    .filter((t) => Number.isFinite(t.createdAt) && t.createdAt >= sinceMs)
    .sort((a, b) => a.createdAt - b.createdAt);
}

interface PersonRow {
  chat_id: number;
  uid: number;
  name: string;
  score: number;
  tier: number | null;
}

/** 高好感的人: RELATIONSHIP_QUANT_ENABLED 时用量化分/tier,否则退回 affinity。 */
function collectTopPeople(): PersonRow[] {
  const nameExpr = `COALESCE(
    NULLIF(TRIM(p.sender_tag), ''),
    NULLIF(TRIM(p.full_name), ''),
    NULLIF(TRIM(p.username), ''),
    CAST(r.uid AS TEXT)
  )`;
  if (env().RELATIONSHIP_QUANT_ENABLED) {
    try {
      return getDb()
        .prepare(
          `SELECT r.chat_id, r.uid, ${nameExpr} AS name, r.quant_score AS score, r.quant_tier AS tier
           FROM chat_relationships r
           LEFT JOIN user_profiles p ON p.chat_id = r.chat_id AND p.uid = r.uid
           WHERE r.uid > 0 AND r.quant_score > 0
           ORDER BY r.quant_score DESC LIMIT ?`,
        )
        .all(TOP_PEOPLE_LIMIT) as PersonRow[];
    } catch (err) {
      logger.debug({ err }, 'dreaming: quant people query failed, falling back to affinity');
    }
  }
  try {
    return getDb()
      .prepare(
        `SELECT r.chat_id, r.uid, ${nameExpr} AS name, r.affinity AS score, NULL AS tier
         FROM chat_relationships r
         LEFT JOIN user_profiles p ON p.chat_id = r.chat_id AND p.uid = r.uid
         WHERE r.uid > 0
         ORDER BY r.affinity DESC LIMIT ?`,
      )
      .all(TOP_PEOPLE_LIMIT) as PersonRow[];
  } catch (err) {
    logger.debug({ err }, 'dreaming: affinity people query failed');
    return [];
  }
}

async function collectDigests(): Promise<string[]> {
  try {
    const raw = await getRedis().lrange(DIGESTS_LIST, 0, MAX_DIGESTS - 1);
    return raw
      .map((r) => {
        try {
          const o = JSON.parse(r) as { at?: number; text?: string };
          const when = o.at ? fmtTs(o.at) : '?';
          return `- [${when}] ${clip(String(o.text ?? '').replace(/\s+/g, ' ').trim(), 300)}`;
        } catch {
          return '';
        }
      })
      .filter(Boolean);
  } catch (err) {
    logger.debug({ err }, 'dreaming: digests unreadable');
    return [];
  }
}

async function collectActiveGroups(): Promise<number[]> {
  try {
    const raw = await getRedis().zrange(ACTIVE_GROUPS_ZSET, 0, -1);
    return raw.map(Number).filter((n) => Number.isFinite(n) && n < 0).slice(-MAX_GROUPS);
  } catch (err) {
    logger.debug({ err }, 'dreaming: active groups unreadable');
    return [];
  }
}

// ── 素材组装 ─────────────────────────────────

/**
 * 构建做梦素材 digest。sinceSec = 上次成功做梦的 started_at(unix 秒)。
 * 总量超 DREAMING_MAX_CONTEXT_CHARS 时确定性裁剪:先丢最旧的 digest 行
 * (二手叙述),再丢最旧的任务行(第一手回忆,尽量保最新),最后硬切。
 */
export async function buildDreamingContext(sinceSec: number): Promise<DreamingContext> {
  const sinceMs = sinceSec * 1000;
  const [tasksAll, people, digestLines, groups] = await Promise.all([
    collectTasks(sinceMs),
    Promise.resolve().then(() => collectTopPeople()),
    collectDigests(),
    collectActiveGroups(),
  ]);

  let sampledOut = 0;
  let tasks = tasksAll;
  if (tasks.length > MAX_TASKS_IN_CONTEXT) {
    sampledOut = tasks.length - MAX_TASKS_IN_CONTEXT;
    tasks = tasks.slice(sampledOut);
  }

  const taskLines = tasks.map((t) => {
    const where = t.chatId > 0 ? `私聊${t.chatId}` : `群${t.chatId}`;
    const dir = clip((t.contentDirection ?? '').replace(/\s+/g, ' ').trim(), 120);
    const result = clip((t.resultSummary ?? '').replace(/\s+/g, ' ').trim(), 120);
    return `- [${t.status}] ${fmtTs(t.createdAt)} ${where}: ${dir}${result ? ` → ${result}` : ''}`;
  });

  const peopleLines = people.map(
    (p) =>
      `- ${clip(String(p.name).trim(), 32)} (uid:${p.uid}, ${p.chat_id > 0 ? '私聊' : `群${p.chat_id}`}` +
      `${p.tier !== null ? `, Tier${p.tier}` : ''}, 分 ${Math.round(p.score)})`,
  );

  const header = [
    `# 做梦素材（${new Date(sinceMs).toISOString()} 以来）`,
    '',
    `这是上次做梦以来你实际做过的事、你在乎的人、最近的意识流。读它像回忆今天——可以作为今晚行动的起点，但不用被它牵着走。`,
  ].join('\n');

  const assemble = (taskLs: string[], digLs: string[]): string =>
    [
      header,
      '',
      `## 本周期你做过的事 (${tasksAll.length} 条${sampledOut ? `, 仅列最新 ${taskLs.length} 条` : ''})`,
      ...(taskLs.length ? taskLs : ['(本周期没有派发过任务)']),
      '',
      `## 你在乎的人`,
      ...(peopleLines.length ? peopleLines : ['(暂无关系记录)']),
      '',
      `## 最近的意识流 digest`,
      ...(digLs.length ? digLs : ['(无)']),
      '',
      `## 活跃群`,
      groups.length ? groups.join(', ') : '(无)',
    ].join('\n');

  let droppedTasks = 0;
  let droppedDigests = 0;
  let text = assemble(taskLines, digestLines);
  // digest 是 Meta 的二手叙述(dream-journal 口径: 不可当事实),超预算先丢;
  // 任务行是「你实际做过的事」,是第一手回忆,尽量保住最新的。
  while (text.length > DREAMING_MAX_CONTEXT_CHARS && droppedDigests < digestLines.length) {
    droppedDigests++;
    text = assemble(taskLines, digestLines.slice(droppedDigests));
  }
  while (text.length > DREAMING_MAX_CONTEXT_CHARS && droppedTasks < taskLines.length) {
    droppedTasks++;
    text = assemble(taskLines.slice(droppedTasks), digestLines.slice(droppedDigests));
  }
  if (text.length > DREAMING_MAX_CONTEXT_CHARS) {
    text = `${text.slice(0, DREAMING_MAX_CONTEXT_CHARS - 40)}\n…(素材过长已截断)`;
  }
  if (droppedTasks + droppedDigests > 0) {
    logger.debug({ droppedTasks, droppedDigests }, 'dreaming: context trimmed to budget');
  }
  return { text, tasksReviewed: tasksAll.length };
}

// ── run 台账 ─────────────────────────────────

/** 有活的 running 行 → 返回它(挡新 run);stale 的顺手标 failed 后返回 null。 */
function blockingRun(nowSec: number): RunRow | null {
  const row = getDb()
    .prepare(
      `SELECT id, started_at FROM dreaming_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1`,
    )
    .get() as RunRow | undefined;
  if (!row) return null;
  if (nowSec - row.started_at < DREAMING_STALE_SEC) return row;
  getDb()
    .prepare(
      `UPDATE dreaming_runs SET ended_at = ?, status = 'failed', summary = 'stale_timeout' WHERE id = ?`,
    )
    .run(nowSec, row.id);
  logger.warn({ runId: row.id, startedAt: row.started_at }, 'dreaming: stale run marked failed');
  return null;
}

function lastDoneStartSec(): number | null {
  const row = getDb()
    .prepare(`SELECT MAX(started_at) AS s FROM dreaming_runs WHERE status = 'done'`)
    .get() as { s: number | null } | undefined;
  return row?.s ?? null;
}

function finishRun(
  runId: number,
  nowSec: number,
  status: 'done' | 'failed',
  tasksReviewed: number,
  summary: string,
): void {
  try {
    getDb()
      .prepare(
        `UPDATE dreaming_runs SET ended_at = ?, status = ?, tasks_reviewed = ?, summary = ? WHERE id = ?`,
      )
      .run(nowSec, status, tasksReviewed, clip(summary, 400), runId);
  } catch (err) {
    logger.warn({ err, runId }, 'dreaming: finish run row failed');
  }
}

function loadDreamingPrompt(): string {
  try {
    const p = loadCachedPrompt('task/dreaming.md').trim();
    if (p) return p;
  } catch (err) {
    logger.warn({ err }, 'dreaming: prompt load failed, using embedded fallback');
  }
  return FALLBACK_DREAMING_PROMPT;
}

// ── 主入口 ────────────────────────────────────

/**
 * 每晚一次:护栏检查 → 建 run 行 → 组装素材 → 派发一个做梦长任务到主人 DM。
 * run 行在**成功入队后**直接标 done(summary 记 'dispatched: <taskId>') ——
 * cron 的职责到派发为止,任务本身的终态由 CodeAct executor/task-store 追踪。
 */
export async function runDreaming(): Promise<DreamingResult> {
  if (!env().DREAMING_ENABLED) return { status: 'skipped', reason: 'disabled' };
  const nowSec = Math.floor(Date.now() / 1000);

  let runId: number;
  try {
    const live = blockingRun(nowSec);
    if (live) {
      logger.info({ runId: live.id }, 'dreaming: another run still live, skip');
      return { status: 'skipped', reason: 'already_running' };
    }
    runId = Number(
      getDb().prepare(`INSERT INTO dreaming_runs (started_at, status) VALUES (?, 'running')`).run(nowSec)
        .lastInsertRowid,
    );
  } catch (err) {
    logger.warn({ err }, 'dreaming: run guard failed');
    return { status: 'failed', reason: 'guard_db_failed' };
  }

  try {
    const master = env().MASTER_UID;
    if (master <= 0) {
      finishRun(runId, nowSec, 'failed', 0, 'no_master_uid');
      return { status: 'failed', reason: 'no_master_uid', runId };
    }

    const since = lastDoneStartSec() ?? nowSec - DEFAULT_WINDOW_SEC;
    const ctx = await buildDreamingContext(since);
    const prompt = loadDreamingPrompt();

    const taskId = `dreaming_${nowSec}_${Math.floor(Math.random() * 1e6)}`;
    await enqueueCodeActJob({
      id: taskId,
      // 主人 DM:沙盒/记忆挂靠身份;prompt 里的硬边界约束 sendText 只来这儿。
      // 不带 messageThreadId —— DM 无 forum topic。
      chatId: master,
      contentDirection:
        `[dreaming] 凌晨做梦任务（特权后台，主人私聊）。\n\n` +
        `${prompt}\n\n` +
        `## 今晚的素材\n${ctx.text}`,
      toneGuidance: '安静、自主，像夜里做梦一样',
      createdAt: Date.now(),
      status: 'queued',
    });

    finishRun(runId, Math.floor(Date.now() / 1000), 'done', ctx.tasksReviewed, `dispatched: ${taskId}`);
    logger.info({ runId, taskId, tasksReviewed: ctx.tasksReviewed }, 'dreaming task dispatched');
    return { status: 'done', reason: 'dispatched', runId, taskId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishRun(runId, Math.floor(Date.now() / 1000), 'failed', 0, msg);
    logger.warn({ err, runId }, 'dreaming dispatch failed');
    return { status: 'failed', reason: 'dispatch_failed', runId };
  }
}
