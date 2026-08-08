// ────────────────────────────────────────
// Unified Tick — 统一唤醒循环 (AGI Level 5 P5-A)
//
// 旧世界：idle / proactive-scan / proactive-thinker / self-play / goal-check
// 五个 cron 各自拉数据、各自 LLM 判断、互相用 proactive-coordinator 锁防打架。
// 新世界：一次 tick 组装「世界状态包」→ 一次 LLM 决定这一个 tick 干什么
// → 映射到既有的执行器（执行保留，决策合并）。
//
// 好处：N 次决策 LLM → 1 次；行为互斥天然成立（一个 tick 只干一件事）；
// 人格一致——同一个决策点出来的行为风格统一。
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { getRecent } from '../pipeline/context/manager.js';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { isAsleep } from '../tracking/sleep.js';
import { isWithinActiveHours } from './active-hours.js';

// ── 动作类型 ──────────────────────────────

export type TickAction =
  | { type: 'care_master'; text: string }
  | { type: 'group_speak'; chatId: number }
  | { type: 'self_play'; idea: string; plan: string[] }
  | { type: 'check_goal'; goalId: number }
  | { type: 'quiet'; reason: string };

export interface TickVerdict {
  action: TickAction;
  reason: string;
}

// ── 世界状态包 ────────────────────────────

export interface WorldState {
  hourBeijing: number;
  masterSilentSec: number | null; // null = MASTER_UID 未配
  masterLastText: string;
  groups: { chatId: number; silentSec: number; lastTexts: string }[];
  dueGoals: { id: number; topic: string; lastFinding: string | null }[];
  rssNewCount: number;
  selfPlayCooldownLeftSec: number;
  lastCareAgoSec: number;
}

const LAST_CARE_KEY = 'xxb:proactive:last_care:';
const LAST_POKE_PREFIX = 'xxb:last_poke:';
const SELFPLAY_LAST_KEY = 'xxb:selfplay:last';

function hourBeijing(): number {
  return parseInt(
    new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }),
    10,
  );
}

async function discoverGroups(): Promise<number[]> {
  const redis = getRedis();
  const raw = await redis.zrange('xxb:active_groups', 0, -1);
  return raw.map(Number).filter((n) => !Number.isNaN(n) && n < 0);
}

/** 组装世界状态。任何单个数据源失败降级为默认值，不炸整个 tick。 */
export async function buildWorldState(): Promise<WorldState> {
  const e = env();
  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);

  // 主人 DM
  let masterSilentSec: number | null = null;
  let masterLastText = '(无)';
  if (e.MASTER_UID > 0) {
    try {
      const recent = await getRecent(e.MASTER_UID, 6);
      if (recent.length) {
        masterSilentSec = now - (recent[recent.length - 1]!.timestamp ?? now);
        masterLastText = recent
          .slice(-4)
          .map((m) => `${m.role === 'assistant' ? '[bot]' : '[主人]'} ${(m.textContent ?? '').slice(0, 60)}`)
          .join(' / ');
      }
    } catch { /* keep defaults */ }
  }

  // 群（最多 5 个，取最近活跃的）
  const groups: WorldState['groups'] = [];
  try {
    const chatIds = (await discoverGroups()).slice(0, 5);
    for (const chatId of chatIds) {
      try {
        const recent = await getRecent(chatId, 6);
        if (!recent.length) continue;
        const silentSec = now - (recent[recent.length - 1]!.timestamp ?? now);
        const lastTexts = recent
          .slice(-3)
          .map((m) => `${m.role === 'assistant' ? '[bot]' : (m.fullName || m.username || '?')}: ${(m.textContent ?? '').slice(0, 50)}`)
          .join(' / ');
        groups.push({ chatId, silentSec, lastTexts });
      } catch { /* skip chat */ }
    }
    groups.sort((a, b) => a.silentSec - b.silentSec);
  } catch { /* keep empty */ }

  // 到期 goals（常驻——goal 追踪是核心能力）
  let dueGoals: WorldState['dueGoals'] = [];
  try {
    const { listDueGoals } = await import('../agent/goals.js');
    dueGoals = listDueGoals(now).map((g) => ({ id: g.id, topic: g.topic, lastFinding: g.last_finding }));
  } catch { /* keep empty */ }

  // RSS fuel（所有群的 fuel 总量，粗粒度即可）
  let rssNewCount = 0;
  if (e.RSS_MONITOR_ENABLED) {
    try {
      const keys = await redis.keys('xxb:rss:fuel:*');
      for (const k of keys.slice(0, 5)) {
        rssNewCount += await redis.llen(k);
      }
    } catch { /* keep 0 */ }
  }

  // self-play 冷却
  let selfPlayCooldownLeftSec = 0;
  try {
    const lastRaw = await redis.get(SELFPLAY_LAST_KEY);
    if (lastRaw) {
      const left = e.SELF_PLAY_COOLDOWN_SEC - (now - parseInt(lastRaw, 10));
      selfPlayCooldownLeftSec = Math.max(0, left);
    }
  } catch { /* keep 0 */ }

  // 上次关心主人（proactive-thinker 的 Redis key，兼容旧 cron 共存期）
  let lastCareAgoSec = Number.MAX_SAFE_INTEGER;
  try {
    const raw = await redis.get(LAST_CARE_KEY + e.MASTER_UID);
    if (raw) lastCareAgoSec = now - parseInt(raw, 10);
  } catch { /* keep max */ }

  return {
    hourBeijing: hourBeijing(),
    masterSilentSec,
    masterLastText: masterLastText.slice(0, 400),
    groups,
    dueGoals,
    rssNewCount,
    selfPlayCooldownLeftSec,
    lastCareAgoSec,
  };
}

// ── LLM 决策 ─────────────────────────────

function parseTickVerdict(raw: string): TickVerdict | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    const type = obj['action'];
    const reason = typeof obj['reason'] === 'string' ? (obj['reason'] as string).slice(0, 150) : '';
    if (type === 'care_master' && typeof obj['text'] === 'string' && (obj['text'] as string).trim()) {
      return { action: { type, text: (obj['text'] as string).trim().slice(0, 300) }, reason };
    }
    if (type === 'group_speak' && typeof obj['chatId'] === 'number') {
      return { action: { type, chatId: obj['chatId'] as number }, reason };
    }
    if (type === 'self_play' && typeof obj['idea'] === 'string' && (obj['idea'] as string).trim()) {
      const plan = Array.isArray(obj['plan'])
        ? (obj['plan'] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 5)
        : [];
      return { action: { type, idea: (obj['idea'] as string).trim().slice(0, 200), plan }, reason };
    }
    if (type === 'check_goal' && typeof obj['goalId'] === 'number') {
      return { action: { type, goalId: obj['goalId'] as number }, reason };
    }
    return { action: { type: 'quiet', reason: reason || 'default' }, reason };
  } catch {
    return null;
  }
}

const TICK_SYSTEM = `你是一个 AI 猫娘的「节律中枢」。每 5 分钟你醒一次，看一眼世界，决定这一个周期做**一件**事——或者继续安静。

可选动作（只能选一个）：
- care_master: 主人沉默很久了，主动关心一句。text=要说的话（像朋友，别像客服）。主人沉默 <4h 通常不该选。
- group_speak: 某个群冷场了，去冒个泡。chatId=目标群。沉默 <60min 的群不该选；选沉默最久且最近聊得不错的。
- self_play: 大家都沉默、自己也休息够了，自己找点事做（写代码/探索）。idea+plan。
- check_goal: 有到期关注目标，去查查进展。goalId。
- quiet: 没什么值得做的——这是最常见的答案，硬找事做不如安静。深夜、刚说过话、没什么新鲜事时选它。

判断原则（像真人，不像机器）：
- 真人不会每 5 分钟都想说话。quiet 是默认，其他动作要有真实理由。
- 深夜（23-8 点）除非主人刚发过消息，否则 quiet。
- 一个 tick 只干一件事。多件都想做时挑最重要的，其他的下个 tick 再说。

只输出 JSON：{"action": "quiet|care_master|group_speak|self_play|check_goal", "chatId": 数字(可选), "goalId": 数字(可选), "text": "…"(可选), "idea": "…"(可选), "plan": ["…"](可选), "reason": "一句话为什么"}`;

/** 单次 LLM 决策。失败 → quiet（fail-closed）。 */
export async function decideTick(state: WorldState): Promise<TickVerdict> {
  const groupLines = state.groups.length
    ? state.groups
        .map((g) => `  群 ${g.chatId}: 沉默 ${Math.floor(g.silentSec / 60)} 分钟。最近: ${g.lastTexts.slice(0, 150)}`)
        .join('\n')
    : '  (无活跃群)';
  const goalLines = state.dueGoals.length
    ? state.dueGoals.map((g) => `  goal#${g.id}: 「${g.topic}」${g.lastFinding ? `上次发现: ${g.lastFinding.slice(0, 60)}` : '(首次检查)'}`).join('\n')
    : '  (无到期目标)';
  const user = [
    `现在北京时间 ${state.hourBeijing} 点。`,
    ``,
    `主人 DM: ${state.masterSilentSec === null ? '(未配置)' : `沉默 ${Math.floor(state.masterSilentSec / 3600)} 小时`}。最近: ${state.masterLastText}`,
    `上次主动关心主人: ${state.lastCareAgoSec === Number.MAX_SAFE_INTEGER ? '从来没有' : `${Math.floor(state.lastCareAgoSec / 3600)} 小时前`}`,
    ``,
    `群:`,
    groupLines,
    ``,
    `到期关注目标:`,
    goalLines,
    ``,
    `RSS 新资讯: ${state.rssNewCount} 条待消化`,
    `self-play 冷却: ${state.selfPlayCooldownLeftSec > 0 ? `还有 ${Math.floor(state.selfPlayCooldownLeftSec / 60)} 分钟` : '已就绪'}`,
    ``,
    `这个周期做什么？`,
  ].join('\n');

  try {
    const res = await Promise.race([
      callWithFallback({
        usage: env().UNIFIED_TICK_USAGE,
        messages: [
          { role: 'system', content: TICK_SYSTEM },
          { role: 'user', content: user },
        ],
        maxTokens: 400,
        temperature: 0.7,
      }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('tick_timeout')), 25_000)),
    ]);
    const verdict = parseTickVerdict(res.content ?? '');
    if (!verdict) return { action: { type: 'quiet', reason: 'parse_failed' }, reason: 'parse_failed' };
    return verdict;
  } catch (err) {
    logger.debug({ err }, 'decideTick failed (fail-quiet)');
    return { action: { type: 'quiet', reason: 'llm_failed' }, reason: 'llm_failed' };
  }
}

// ── 动作执行（映射到既有执行器，执行保留）─────

async function executeVerdict(verdict: TickVerdict, state: WorldState): Promise<void> {
  const e = env();
  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);
  const a = verdict.action;

  switch (a.type) {
    case 'quiet':
      logger.info({ reason: verdict.reason }, 'unified tick: quiet');
      return;

    case 'care_master': {
      if (e.MASTER_UID <= 0) return;
      const { tryAcquireProactiveSlot, markProactiveSent } = await import('./proactive-coordinator.js');
      if (!(await tryAcquireProactiveSlot(e.MASTER_UID, 'unified-tick'))) return;
      try {
        const { sendMessage } = await import('../bot/sender/telegram.js');
        const { addAssistant } = await import('../pipeline/context/manager.js');
        const messageId = await sendMessage(e.MASTER_UID, a.text);
        if (messageId) {
          await addAssistant(e.MASTER_UID, { textContent: a.text, messageId });
        }
        await redis.set(LAST_CARE_KEY + e.MASTER_UID, String(now));
        await markProactiveSent(e.MASTER_UID, 'unified-tick');
        logger.info({ text: a.text.slice(0, 60) }, 'unified tick: cared for master');
      } catch (err) {
        logger.warn({ err }, 'unified tick: care_master send failed');
      }
      return;
    }

    case 'group_speak': {
      // 校验 chatId 是世界状态里的真实群（防模型编造）
      if (!state.groups.some((g) => g.chatId === a.chatId)) {
        logger.info({ chatId: a.chatId }, 'unified tick: group_speak rejected — unknown chat');
        return;
      }
      const { tryAcquireProactiveSlot, markProactiveSent } = await import('./proactive-coordinator.js');
      if (!(await tryAcquireProactiveSlot(a.chatId, 'unified-tick'))) return;
      const { generatePersonaProactiveText } = await import('../pipeline/turn/proactive-turn.js');
      const { getBotUid } = await import('../bot/bot.js');
      const silentMin = Math.floor((state.groups.find((g) => g.chatId === a.chatId)?.silentSec ?? 0) / 60);
      const text = await generatePersonaProactiveText(
        a.chatId,
        getBotUid(),
        `[主动开口·冷场] 群里已经沉默 ${silentMin} 分钟了。你可以自然地发起一个话题、接着之前聊的随口说一句、或分享点有意思的。禁止自我介绍、禁止「大家好」式开场。`,
      );
      if (!text) {
        logger.debug({ chatId: a.chatId }, 'unified tick: persona declined group speak');
        return;
      }
      const { sendMessage } = await import('../bot/sender/telegram.js');
      const { addAssistant } = await import('../pipeline/context/manager.js');
      const messageId = await sendMessage(a.chatId, text);
      if (messageId) {
        await addAssistant(a.chatId, { textContent: text, messageId });
      }
      await redis.set(LAST_POKE_PREFIX + a.chatId, String(now));
      await markProactiveSent(a.chatId, 'unified-tick');
      logger.info({ chatId: a.chatId }, 'unified tick: spoke in group');
      return;
    }

    case 'self_play': {
      if (state.selfPlayCooldownLeftSec > 0) {
        logger.info('unified tick: self_play vetoed by cooldown');
        return;
      }
      const { enqueueCodeActJob } = await import('../subagent/queue.js');
      const planText = a.plan.length ? `\n计划:\n${a.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '';
      await enqueueCodeActJob({
        id: `selfplay_${now}_${Math.floor(Math.random() * 1e6)}`,
        chatId: e.MASTER_UID > 0 ? e.MASTER_UID : 0,
        contentDirection: `[selfplay] 自主行动：${a.idea}${planText}\n没有人在等你，自己完成它。做完了 sendText 汇报，产物存沙盒。`,
        toneGuidance: '自主、专注、完成后自然汇报',
        createdAt: Date.now(),
        status: 'queued',
      });
      await redis.set(SELFPLAY_LAST_KEY, String(now));
      logger.info({ idea: a.idea.slice(0, 80) }, 'unified tick: self-play dispatched');
      return;
    }

    case 'check_goal': {
      if (!state.dueGoals.some((g) => g.id === a.goalId)) {
        logger.info({ goalId: a.goalId }, 'unified tick: check_goal rejected — not due');
        return;
      }
      try {
        const { listGoals } = await import('../agent/goals.js');
        const goal = listGoals('active').find((g) => g.id === a.goalId);
        if (!goal) return;
        const { enqueueCodeActJob } = await import('../subagent/queue.js');
        await enqueueCodeActJob({
          id: `goal_${goal.id}_${now}_${Math.floor(Math.random() * 1e6)}`,
          chatId: goal.chat_id ?? (e.MASTER_UID > 0 ? e.MASTER_UID : 0),
          contentDirection:
            `[goal:${goal.id}] 持续关注：「${goal.topic}」。` +
            `用 web.search 搜一下最新进展，或翻看最近聊天里有没有相关话题。` +
            (goal.last_finding ? `上次发现：${goal.last_finding}——看看有没有新进展。` : `这是第一次检查。`) +
            `有新发现就 sendText 简短汇报，没有就什么都不说直接 runtime.endTask。` +
            `最后必须 runtime.endTask("found: …" 或 "no_update")。`,
          toneGuidance: '自然分享，不像新闻播报',
          createdAt: Date.now(),
          status: 'queued',
        });
        logger.info({ goalId: goal.id, topic: goal.topic.slice(0, 60) }, 'unified tick: goal check dispatched');
      } catch (err) {
        logger.warn({ err, goalId: a.goalId }, 'unified tick: check_goal failed');
      }
      return;
    }
  }
}

/** Test helper — expose the parser for unit tests. */
export function parseTickVerdictForTest(raw: string): TickVerdict | null {
  return parseTickVerdict(raw);
}

// ── 主入口 ────────────────────────────────

export async function runUnifiedTick(): Promise<void> {
  const e = env();
  try {
    if (!isWithinActiveHours(e.UNIFIED_TICK_HOUR_START, e.UNIFIED_TICK_HOUR_END)) return;
    if (await isAsleep()) {
      logger.debug('unified tick: asleep');
      return;
    }
    const state = await buildWorldState();
    const verdict = await decideTick(state);
    await executeVerdict(verdict, state);
  } catch (err) {
    logger.warn({ err }, 'runUnifiedTick failed');
  }
}
