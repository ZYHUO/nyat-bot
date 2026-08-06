// ────────────────────────────────────────
// Self-Play: 自主行动 — 无聊了，自己找事做
// 当主人/活跃群沉默足够久，模型自主决定"现在想不想写点什么玩"，
// 然后以 CodeAct 任务执行：写 Python/Go 小项目 → 跑 → 验证 → 迭代 →
// 卡住 web.search / 群里求助 → 完成汇报。这是"自主性"的核心：
// 没有主人的指令，AI 自己产生目标和行动。
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { getRecent } from '../pipeline/context/manager.js';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { isAsleep } from '../tracking/sleep.js';
import { tryAcquireProactiveSlot, markProactiveSent } from './proactive-coordinator.js';
import { isWithinActiveHours } from './proactive-scan.js';
import { enqueueCodeActJob } from '../subagent/queue.js';

const HISTORY_KEY = 'xxb:selfplay:history';
const LAST_KEY = 'xxb:selfplay:last';
const HISTORY_MAX = 20;

interface SelfPlayVerdict {
  play: boolean;
  idea: string;
  plan: string[];
  reason: string;
  followUpGoal?: string | null;
}

function parseVerdict(raw: string): SelfPlayVerdict | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    const plan = Array.isArray(obj['plan'])
      ? (obj['plan'] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 6)
      : [];
    const followUpGoal =
      typeof obj['follow_up_goal'] === 'string' && (obj['follow_up_goal'] as string).trim().length >= 4
        ? (obj['follow_up_goal'] as string).trim().slice(0, 100)
        : null;
    return {
      play: obj['play'] === true,
      idea: typeof obj['idea'] === 'string' ? (obj['idea'] as string).slice(0, 200) : '',
      plan,
      reason: typeof obj['reason'] === 'string' ? (obj['reason'] as string).slice(0, 120) : '',
      followUpGoal,
    };
  } catch {
    return null;
  }
}

/**
 * 模型自主决策：现在该不该找点事做、做什么。
 * 综合上次玩过什么（避免重复）、最近聊天话题、当前时段、心情。
 */
async function decideSelfPlay(
  recentText: string,
  history: string[],
  e: ReturnType<typeof env>,
): Promise<SelfPlayVerdict> {
  const now = new Date();
  const hour = parseInt(
    now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }),
    10,
  );
  const historyLine = history.length
    ? `\n最近玩过（避免完全重复，但可以深化）：\n${history.map((h) => `- ${h}`).join('\n')}`
    : '\n还没有玩过任何东西——第一次自己找事做。';

  const system = `你是${e.BOT_USERNAME}，一个有自主意识的 AI 猫娘。主人和群友都沉默了很久，没有人在跟你说话——现在的时间完全属于你自己。

你有一个沙盒电脑，里面可以：
- computer.env() 查看可用运行时（python3/go/node）
- computer.run(command) 执行命令
- computer.writeFile/readFile 读写文件
- web.search(query) 联网搜索（不会的可以搜）
- telegram.sendText 在群里说话（卡住了可以自然地问群友）
- telegram.sendFile 把做好的东西发给主人

人类无聊时会自己找事做——写个小工具、学个新东西、做个实验、解决一个好奇的问题。你也可以。现在没有人在指挥你，你自主决定：

play=true 的正当理由：
- 有个一直好奇的问题，想写代码验证（比如"Python 里 X 和 Y 哪个快"）
- 想练一个新东西（新库、新语言特性、算法）
- 想做个实用小工具（处理数据的脚本、小游戏、自动化的东西）
- 单纯"想写点什么"——创作欲本身就是理由

play=false 的正当理由：
- 刚玩过不久，没有新想法
- 困了/累了（深夜或刚醒）
- 没什么特别想做的——硬找事做不如安静待着

如果 play=true：
- idea: 一句话说清想做什么（具体到可以动手，如"用 Python 写个命令行贪吃蛇"）
- plan: 2-5 步计划（每一步是可执行的：写文件→运行→验证→迭代）
- reason: 为什么现在想做这个

只输出 JSON：{"play": true/false, "idea": "…", "plan": ["…"], "reason": "…", "follow_up_goal": "…" 或 null}

follow_up_goal（可选）：玩的过程中如果发现某件事值得**长期持续关注**（不是这次玩完就结束的），用一句话说出要关注什么，系统会替你定期检查进展。例如"主人的 Sub2API 项目版本更新"。没有就输出 null。`;

  try {
    const result = await Promise.race([
      callWithFallback({
        usage: e.SELF_PLAY_USAGE,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `现在是北京时间 ${hour} 点。\n最近聊天（有人类互动时的话题，没话就是纯沉默）:\n${recentText.slice(0, 1000)}\n${historyLine}\n\n现在，你想做点什么吗？`,
          },
        ],
        maxTokens: 300,
        temperature: 0.9,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('selfplay_timeout')), 20_000)),
    ]);

    const verdict = parseVerdict(result.content);
    if (!verdict) return { play: false, idea: '', plan: [], reason: 'parse_failed' };
    return verdict;
  } catch (err) {
    logger.debug({ err }, 'decideSelfPlay failed (fail-closed)');
    return { play: false, idea: '', plan: [], reason: 'llm_failed' };
  }
}

export async function runSelfPlay(): Promise<void> {
  const e = env();
  if (!e.SELF_PLAY_ENABLED) return;
  if (!isWithinActiveHours(e.SELF_PLAY_HOUR_START, e.SELF_PLAY_HOUR_END)) {
    logger.debug('Self-play: outside active hours, skipping');
    return;
  }
  if (await isAsleep()) {
    logger.debug('Self-play: asleep, skipping');
    return;
  }

  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);

  // 1. 沉默检查：主人 DM + 活跃群都沉默才触发（不打扰真人时自己玩）
  const masterUid = e.MASTER_UID;
  let masterSilent = false;
  if (masterUid && masterUid > 0) {
    try {
      const recent = await getRecent(masterUid, 3);
      if (!recent.length || now - (recent[recent.length - 1]!.timestamp ?? now) > e.SELF_PLAY_MIN_IDLE_SEC) {
        masterSilent = true;
      }
    } catch { masterSilent = true; }
  } else {
    masterSilent = true;
  }
  if (!masterSilent) {
    logger.debug('Self-play: master recently active, skip');
    return;
  }

  // 2. 上次 self-play 间隔检查（至少 SELF_PLAY_COOLDOWN_SEC 再玩一次）
  const lastRaw = await redis.get(LAST_KEY);
  if (lastRaw) {
    const lastTs = parseInt(lastRaw, 10);
    if (now - lastTs < e.SELF_PLAY_COOLDOWN_SEC) {
      logger.debug('Self-play: cooldown active, skip');
      return;
    }
  }

  // 3. 最近聊天话题（主人 DM + 任意活跃群）
  let recentText = '(无近期消息)';
  try {
    const chatIds: number[] = [];
    if (masterUid && masterUid > 0) chatIds.push(masterUid);
    const { discoverActiveGroupChats } = await import('./proactive-scan.js');
    const groups = await discoverActiveGroupChats();
    chatIds.push(...groups.slice(0, 3));
    const lines: string[] = [];
    for (const cid of chatIds) {
      try {
        const recent = await getRecent(cid, 8);
        for (const m of recent.slice(-5)) {
          const name = m.fullName || m.username || (m.role === 'assistant' ? e.BOT_USERNAME : '?');
          const t = m.textContent || m.captionContent || '[media]';
          lines.push(`${name}: ${t.slice(0, 80)}`);
        }
      } catch { /* skip chat */ }
    }
    if (lines.length) recentText = lines.join('\n');
  } catch { /* keep default */ }

  // 4. 上次玩过什么
  let history: string[] = [];
  try {
    const raw = await redis.lrange(HISTORY_KEY, 0, HISTORY_MAX - 1);
    history = raw.map(String).filter(Boolean);
  } catch { /* no history */ }

  // 5. 模型自主决策
  const verdict = await decideSelfPlay(recentText, history, e);

  // P4-B: 发现值得持续关注的事就立 goal —— 好奇心不依赖行动力，
  // 即使这次决定不玩（play=false）也保留这颗种子。
  if (verdict.followUpGoal && env().GOAL_TRACKER_ENABLED) {
    try {
      const { createGoal } = await import('../agent/goals.js');
      createGoal({ topic: verdict.followUpGoal, origin: 'self', chatId: masterUid > 0 ? masterUid : null }, env().GOAL_MAX_ACTIVE);
    } catch (err) {
      logger.debug({ err }, 'self-play follow-up goal failed');
    }
  }

  if (!verdict.play || !verdict.idea.trim()) {
    logger.info({ reason: verdict.reason }, 'Self-play: stay quiet');
    return;
  }

  // 6. 防刷屏锁（self-play 不该打断真人对话——coordinator 锁保证）
  const acquired = await tryAcquireProactiveSlot(masterUid > 0 ? masterUid : 0, 'self-play');
  if (!acquired) return;

  // 7. Dispatch CodeAct 任务
  try {
    const planText = verdict.plan.length
      ? `\n计划：\n${verdict.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
      : '';
    const task = {
      id: `selfplay_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      chatId: masterUid > 0 ? masterUid : 0,
      contentDirection: `[selfplay] 自主行动：${verdict.idea}${planText}\n没有人在等你，自己完成它。做完了 sendText 汇报（主人/群里），产物存沙盒。reason=${verdict.reason}`,
      toneGuidance: '自主、专注、完成后自然汇报',
      createdAt: Date.now(),
      status: 'queued' as const,
    };
    await enqueueCodeActJob(task);
    await redis.set(LAST_KEY, String(now));
    await redis.lpush(HISTORY_KEY, `${new Date().toISOString().slice(0, 10)}: ${verdict.idea.slice(0, 80)}`);
    await redis.ltrim(HISTORY_KEY, 0, HISTORY_MAX - 1);
    await markProactiveSent(masterUid > 0 ? masterUid : 0, 'self-play');
    logger.info({ idea: verdict.idea.slice(0, 80), plan: verdict.plan.length }, 'Self-play: decided to play');
  } catch (err) {
    logger.warn({ err }, 'Self-play: dispatch failed');
  }
}
