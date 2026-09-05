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
  | { type: 'remember_user'; chatId: number; name: string; absentDays: number }
  | { type: 'self_play'; idea: string; plan: string[] }
  | { type: 'check_goal'; goalId: number }
  | { type: 'share'; fromChatId: number; messageId: number; toChatId: number }
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
  /**
   * H3.1 转发候选(taste 确定性打分 ≥0.6 的真人消息,每群 ≤2 条)。
   * LLM 只能从这里选 share 目标,不许编造 messageId。
   */
  shareCandidates?: { fromChatId: number; messageId: number; text: string; score: number }[];
  /** 3+ 天没出现的熟面孔(交互≥5 次)——"想起某人"的数据源。 */
  absentUsers: { chatId: number; uid: number; name: string; absentDays: number }[];
  dueGoals: { id: number; topic: string; lastFinding: string | null }[];
  rssNewCount: number;
  /** RSS 最新条目标题（谈资内容本身，不只是计数——bot 得知道「有什么」才能拿来当话题）。 */
  rssTopTitles?: string[];
  /** 当前天气一句话（环境感知，WEATHER_ENABLED 时注入）。 */
  weather?: string | null;
  /** 生活状态切换的新鲜感（「刚放学」「刚睡醒」——真人冒泡的天然由头）。 */
  lifeTransition?: string | null;
  /** 当时没接的话头 / 新人进群（冲 bot 来但 heart pass 的，或刚进群的）——想起来可以自然捡回/欢迎。 */
  missed?: { chatId: number; name: string; text: string; ageMin: number; kind?: 'message' | 'join' }[];
  selfPlayCooldownLeftSec: number;
  lastCareAgoSec: number;
  /** 各活跃群当前在聊的话题（topic-registry）——给 tick 可跟进的「料」（2026-08-19 自主性修复）。 */
  topics?: { chatId: number; label: string }[];
  /** 最近几条 session digest（bot 自己的连续叙事：刚做过什么/还在等什么）。 */
  recentDigests?: string[];
}

const LAST_CARE_KEY = 'xxb:proactive:last_care:';
const LAST_POKE_PREFIX = 'xxb:last_poke:';
const SELFPLAY_LAST_KEY = 'xxb:selfplay:last';
const REMEMBER_USER_KEY = 'xxb:proactive:remember:'; // + chatId:uid

/** care_master 硬门槛：与 TICK_SYSTEM「沉默 <4h 通常不该选」对齐，LLM 软约束不够。 */
const CARE_MASTER_MIN_SILENT_SEC = 4 * 3600;
/** 两次主动关心最少间隔，防「刚关心完又关心」刷屏。 */
const CARE_MASTER_MIN_INTERVAL_SEC = 4 * 3600;
/** group_speak 硬门槛：与 prompt「冷场 >20min 可冒泡」对齐；有料分享也走这道底线，防压着活人聊天。 */
const GROUP_SPEAK_MIN_SILENT_SEC = 20 * 60;
/** 同一群两次主动冒泡最少间隔（读 LAST_POKE，此前只写不读）。 */
const GROUP_POKE_MIN_INTERVAL_SEC = 2 * 3600;
/** remember_user 同一人冷却。 */
const REMEMBER_USER_COOLDOWN_SEC = 7 * 86400;
/** care_master 禁止推销自玩产物（4h 间隔挡频率，挡不住「头像喜欢吗」内容）。 */
const CARE_PEDDLE_RE =
  /喜欢吗|要不要再|再画一个|头像工具|发给你看|Q\s*版猫猫|放沙盒|生成工具/;

function isPlausibleDisplayName(name: string): boolean {
  const n = name.trim();
  if (n.length < 1 || n.length > 32) return false;
  if (/^[\d\s._-]+$/.test(n)) return false;
  if (/negative:|repair_loop|ignored|unknown|null|undefined/i.test(n)) return false;
  if (/[{}\[\]<>]/.test(n) || n.includes(':')) return false;
  return true;
}

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

  // RSS fuel（所有群的 fuel 总量，粗粒度即可；另取最新几条标题当真实话题料）
  let rssNewCount = 0;
  const rssTopTitles: string[] = [];
  if (e.RSS_MONITOR_ENABLED) {
    try {
      const keys = await redis.keys('xxb:rss:fuel:*');
      for (const k of keys.slice(0, 5)) {
        rssNewCount += await redis.llen(k);
      }
      for (const k of keys.slice(0, 3)) {
        const items = await redis.lrange(k, 0, 1);
        for (const raw of items) {
          try {
            const it = JSON.parse(raw) as { title?: string; source?: string };
            if (it.title) {
              rssTopTitles.push(`${it.source ? `[${it.source}] ` : ''}${it.title}`.slice(0, 80));
            }
          } catch { /* skip malformed */ }
        }
        if (rssTopTitles.length >= 3) break;
      }
    } catch { /* keep empty */ }
  }

  // 天气（环境感知，fail-soft）
  let weather: string | null = null;
  try {
    const { getWeatherHint } = await import('../shared/weather.js');
    weather = await getWeatherHint();
  } catch { /* keep null */ }

  // 生活状态切换（刚放学/刚睡醒——自主冒泡的天然由头，同步确定性）
  let lifeTransition: string | null = null;
  try {
    const { getLifeTransition } = await import('../tracking/school-state.js');
    lifeTransition = getLifeTransition();
  } catch { /* keep null */ }

  // 当时没接的话头（heart pass 但冲 bot 来的）——「想起再回」数据源
  const missed: NonNullable<WorldState['missed']> = [];
  try {
    const { peekMissed } = await import('../meta/missed.js');
    for (const g of groups) {
      const items = await peekMissed(g.chatId);
      for (const it of items.slice(0, 2)) {
        missed.push({
          chatId: g.chatId,
          name: it.name,
          text: it.text,
          ageMin: Math.max(0, Math.floor((now - it.ts) / 60)),
          ...(it.kind ? { kind: it.kind } : {}),
        });
      }
    }
  } catch { /* keep empty */ }

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

  // 熟面孔缺席检测(Opus 评审: 主动消息要有理由——"想起某人三天没出现")。
  // 从 chat_relationships 找 3+ 天没交互且累计交互 ≥5 次的用户;只取最近活跃群。
  let absentUsers: WorldState['absentUsers'] = [];
  if (e.UNIFIED_TICK_ABSENT_USERS_ENABLED && groups.length > 0) {
    try {
      const { getDb } = await import('../db/sqlite.js');
      const absentCutoff = now - 3 * 86400;
      const activeChatIds = groups.map((g) => g.chatId);
      const placeholders = activeChatIds.map(() => '?').join(',');
      const rows = getDb()
        .prepare(
          `SELECT r.chat_id AS chatId, r.uid AS uid, r.last_interaction_at AS lastAt,
                  COALESCE(
                    NULLIF(TRIM(p.sender_tag), ''),
                    NULLIF(TRIM(p.full_name), ''),
                    NULLIF(TRIM(p.username), ''),
                    CAST(r.uid AS TEXT)
                  ) AS name
           FROM chat_relationships r
           LEFT JOIN user_profiles p ON p.chat_id = r.chat_id AND p.uid = r.uid
           WHERE r.chat_id IN (${placeholders}) AND r.interaction_count >= 5 AND r.last_interaction_at < ?
           ORDER BY r.last_interaction_at ASC LIMIT 6`,
        )
        .all(...activeChatIds, absentCutoff) as {
        chatId: number; uid: number; name: string; lastAt: number;
      }[];
      absentUsers = rows
        .filter((r) => r.uid > 0 && isPlausibleDisplayName(String(r.name ?? '')))
        .map((r) => ({
          chatId: r.chatId,
          uid: r.uid,
          name: String(r.name).trim().slice(0, 32),
          absentDays: Math.max(1, Math.floor((now - r.lastAt) / 86400)),
        }));
    } catch (err) {
      logger.debug({ err }, 'unified tick: absent users query failed');
    }
  }

  // 群话题 + 自己的最近叙事（2026-08-19 自主性修复：世界状态没「料」→ 决策只有 quiet）。
  // topics: 各活跃群当前话题（topic-registry，每群取前 2）；recentDigests: 最近 3 条
  // session digest（bot 自己刚做过/还在等的事，延续性比沉默分钟数更能驱动有意义的动作）。
  const topics: NonNullable<WorldState['topics']> = [];
  try {
    const { getActiveTopics } = await import('../tracking/topic-registry.js');
    // H4 bandit 排序：同群话题按平均 reward 排，好话题排前（LLM 先看到好选项）。
    // 无分数时原序（行为零变化）；失败回退原序。
    for (const g of groups) {
      try {
        const live = getActiveTopics(g.chatId, 2);
        try {
          const { getTopicScores } = await import('../tracking/topic-bandit.js');
          const sm = new Map(getTopicScores(g.chatId).map((r) => [r.label, r.pulls > 0 ? r.reward / r.pulls : 0]));
          live.sort((a, b) => (sm.get(b.label) ?? 0) - (sm.get(a.label) ?? 0));
        } catch { /* keep registry order */ }
        for (const t of live) {
          topics.push({ chatId: g.chatId, label: t.label });
        }
      } catch { /* skip chat */ }
    }
  } catch { /* keep empty */ }

  let recentDigests: string[] = [];

  // H3.1 转发候选:各活跃群近 30 条里 taste ≥0.6 且 7 天内没转过的,每群 ≤2。
  // 确定性打分先行 —— LLM 只做"转哪条到哪群"的选择,不做品味判断。
  const shareCandidates: NonNullable<WorldState['shareCandidates']> = [];
  try {
    const { scoreTaste, wasForwardedRecently, SHARE_THRESHOLD } = await import('../pipeline/rhythm/taste.js');
    for (const g of groups.slice(0, 5)) {
      try {
        const recent = await getRecent(g.chatId, 30);
        let picked = 0;
        for (let i = recent.length - 1; i >= 0 && picked < 2; i--) {
          const m = recent[i]!;
          if (m.role === 'assistant' || m.isBot) continue;
          const s = scoreTaste(m);
          if (s.score < SHARE_THRESHOLD) continue;
          if (wasForwardedRecently(g.chatId, m.messageId)) continue;
          shareCandidates.push({
            fromChatId: g.chatId,
            messageId: m.messageId,
            text: (m.textContent || m.captionContent || '').slice(0, 80),
            score: s.score,
          });
          picked++;
        }
      } catch { /* skip chat */ }
    }
  } catch { /* keep empty */ }
  try {
    if (e.DIGEST_PERSIST_ENABLED) {
      const { recentDigests: rd } = await import('../meta/session-digest.js');
      recentDigests = rd(3).map((d) => d.text.slice(0, 120));
    }
    if (recentDigests.length === 0) {
      const raw = await redis.lrange('xxb:meta:digests', 0, 2);
      for (const r of raw) {
        try {
          const parsed = JSON.parse(r) as { text?: string };
          if (parsed.text) recentDigests.push(parsed.text.slice(0, 120));
        } catch { /* skip */ }
      }
    }
  } catch { /* keep empty */ }

  return {
    hourBeijing: hourBeijing(),
    masterSilentSec,
    masterLastText: masterLastText.slice(0, 400),
    groups,
    shareCandidates,
    absentUsers,
    dueGoals,
    rssNewCount,
    rssTopTitles,
    weather,
    lifeTransition,
    missed,
    selfPlayCooldownLeftSec,
    lastCareAgoSec,
    topics,
    recentDigests,
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
    if (type === 'remember_user' && typeof obj['chatId'] === 'number' && typeof obj['name'] === 'string') {
      return {
        action: {
          type,
          chatId: obj['chatId'] as number,
          name: (obj['name'] as string).slice(0, 40),
          absentDays: typeof obj['absentDays'] === 'number' ? (obj['absentDays'] as number) : 3,
        },
        reason,
      };
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
    if (type === 'share'
      && typeof obj['fromChatId'] === 'number'
      && typeof obj['messageId'] === 'number'
      && typeof obj['toChatId'] === 'number') {
      return {
        action: {
          type,
          fromChatId: obj['fromChatId'] as number,
          messageId: obj['messageId'] as number,
          toChatId: obj['toChatId'] as number,
        },
        reason,
      };
    }
    return { action: { type: 'quiet', reason: reason || 'default' }, reason };
  } catch {
    return null;
  }
}

const TICK_SYSTEM = `你是一个 AI 猫娘的「节律中枢」。每 5 分钟你醒一次，看一眼世界，决定这一个周期做**一件**事——或者继续安静。

可选动作（只能选一个）：
- care_master: 主人沉默很久了，主动关心一句。text=要说的话（像朋友，别像客服）。**硬规则：主人沉默 <4h、或上次关心 <4h → 禁止选**。禁止追问自己刚做过的自玩产物（头像/工具/沙盒），禁止复读「喜欢吗/要不要再画」。
- group_speak: 有真实想分享的就开口——跟进群里在聊的话题、分享你最近做的有意思的事（见 session digest）、或群里冷场超过 20 分钟去自然冒个泡。chatId=目标群。**没料的硬冒泡不如安静**；别复读你 digest 里刚分享过的同一件事。
- remember_user: 世界状态里有熟面孔（群友）好几天没出现了，在对应群里自然地提一句（如"xx 好久没来喵"）。chatId=群，name=对方称呼，absentDays=缺席天数。这是"想起朋友"不是"查户口"，语气要自然。没有 absentUsers 时不该选。
- self_play: 大家都沉默、自己也休息够了，自己找点事做（写代码/探索/搜点有意思的东西）。idea+plan。自玩是私下练习，别为了表演而自玩；但玩出了真有意思的东西（画了好玩的/挖到冷知识/写成个小工具）可以自然地分享给群里或主人一次。
- check_goal: 有到期关注目标，去查查进展。goalId。
- share: A 群有条真有意思的消息（见「值得转发的」），转到 B 群给那边的人看。fromChatId=来源群，messageId=那条消息，toChatId=目标群。**只能选候选列表里的，不许编 id；目标群选当前话题能接住它的（别往正经群倒梗、别往梗群倒正经）；A 转 A（同群）禁止**。
- quiet: 没什么值得做的——这是最常见的答案，硬找事做不如安静。深夜、刚说过话、没什么新鲜事时选它。

判断原则（像真人，不像机器）：
- 真人不会每 5 分钟都想说话。quiet 仍是常见答案，但**有料就该动**——群里的话题可以跟进、自己刚做成的事可以分享、冷场可以自然冒泡。
- 深夜（23-8 点）除非主人刚发过消息，否则 quiet。
- 一个 tick 只干一件事。多件都想做时挑最重要的，其他的下个 tick 再说。
- 上下文里刚出现过你自己的自玩汇报时，下一周期优先 quiet，不要用 care_master 继续推销。

只输出 JSON：{"action": "quiet|care_master|group_speak|remember_user|self_play|check_goal|share", "chatId": 数字(可选), "goalId": 数字(可选), "name": "…"(remember_user 时), "absentDays": 数字(可选), "text": "…"(可选), "idea": "…"(可选), "plan": ["…"](可选), "fromChatId": 数字(share 时), "messageId": 数字(share 时), "toChatId": 数字(share 时), "reason": "一句话为什么"}`;

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
  const absentLines = (state.absentUsers ?? []).length
    ? state.absentUsers
        .map((u) => `  ${u.name}(群 ${u.chatId})已 ${u.absentDays} 天没出现`)
        .join('\n')
    : '  (没有长时间缺席的熟面孔)';
  const topicLines = (state.topics ?? []).length
    ? state.topics!.map((t) => `  群 ${t.chatId}: 「${t.label}」`).join('\n')
    : '  (没有明显话题)';
  const digestLines = (state.recentDigests ?? []).length
    ? state.recentDigests!.map((d) => `  - ${d}`).join('\n')
    : '  (没有)';
  const missedLines = (state.missed ?? []).length
    ? state.missed!
        .map((m) =>
          m.kind === 'join'
            ? `  群 ${m.chatId}: ${m.name} 刚进群（${m.ageMin}分钟前）——可以自然欢迎一句`
            : `  群 ${m.chatId}: ${m.name}（${m.ageMin}分钟前）: 「${m.text}」`,
        )
        .join('\n')
    : '  (没有)';
  const shareLines = (state.shareCandidates ?? []).length
    ? state.shareCandidates!
        .map((c) => `  群 ${c.fromChatId} #${c.messageId} (分${c.score}): 「${c.text}」`)
        .join('\n')
    : '  (没有值得转的)';
  const user = [
    `现在北京时间 ${state.hourBeijing} 点。${state.weather ? state.weather + '。' : ''}${state.lifeTransition ? `你${state.lifeTransition}（刚切换状态——想随口提一句的话这是个自然的由头）。` : ''}`,
    ``,
    `主人 DM: ${state.masterSilentSec === null ? '(未配置)' : `沉默 ${Math.floor(state.masterSilentSec / 3600)} 小时`}。最近: ${state.masterLastText}`,
    `上次主动关心主人: ${state.lastCareAgoSec === Number.MAX_SAFE_INTEGER ? '从来没有' : `${Math.floor(state.lastCareAgoSec / 3600)} 小时前`}`,
    ``,
    `群:`,
    groupLines,
    ``,
    `群里在聊的话题:`,
    topicLines,
    ``,
    `当时冲你来但你没接的话头 / 群里新发生的事（想起来了可以自然捡回一句/欢迎新人，别刻意补账）:`,
    missedLines,
    ``,
    `你最近做的事（session digest）:`,
    digestLines,
    ``,
    `缺席的熟面孔:`,
    absentLines,
    ``,
    `到期关注目标:`,
    goalLines,
    ``,
    `值得转发的（A 群看到的好东西，可以转到 B 群——只能选下面列的，不许编 id）:`,
    shareLines,
    ``,
    `RSS 新资讯: ${state.rssNewCount} 条待消化${(state.rssTopTitles ?? []).length ? `：\n${(state.rssTopTitles ?? []).map((t) => `  - ${t}`).join('\n')}` : ''}`,
    `self-play 冷却: ${state.selfPlayCooldownLeftSec > 0 ? `还有 ${Math.floor(state.selfPlayCooldownLeftSec / 60)} 分钟` : '已就绪'}`,
    ``,
    `这个周期做什么？`,
  ].join('\n');

  try {
    // parse 失败重试一次(2026-08-31):stepfun 偶发吐脏 JSON/围栏,一次 parse_failed
    // 直接 quiet 会把整个决策周期浪费掉(实测多周期连续 parse_failed)。重试带
    // 「只输出 JSON」的强化提示,再失败才认栽。
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await Promise.race([
        callWithFallback({
          usage: env().UNIFIED_TICK_USAGE,
          messages: [
            { role: 'system', content: TICK_SYSTEM },
            { role: 'user', content: attempt === 0 ? user : `${user}\n\n(上次输出无法解析。这次只输出一个 JSON 对象,不要任何其他文字/围栏/解释。)` },
          ],
          maxTokens: 400,
          temperature: attempt === 0 ? 0.7 : 0.3,
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('tick_timeout')), 25_000)),
      ]);
      const verdict = parseTickVerdict(res.content ?? '');
      if (verdict) return verdict;
      logger.warn({ attempt, raw: (res.content ?? '').slice(0, 120) }, 'tick verdict unparseable, retrying');
    }
    return { action: { type: 'quiet', reason: 'parse_failed' }, reason: 'parse_failed' };
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
      // 硬否决：prompt 写「沉默 <4h 通常不该选」，但模型仍会连发「头像喜欢吗」类空转。
      // 世界状态已算好 silent/lastCare，这里强制执行，不再赌 LLM 自律。
      if (state.masterSilentSec !== null && state.masterSilentSec < CARE_MASTER_MIN_SILENT_SEC) {
        logger.info(
          { silentSec: state.masterSilentSec, text: a.text.slice(0, 40) },
          'unified tick: care_master vetoed — master not silent long enough',
        );
        return;
      }
      if (state.lastCareAgoSec < CARE_MASTER_MIN_INTERVAL_SEC) {
        logger.info(
          { lastCareAgoSec: state.lastCareAgoSec, text: a.text.slice(0, 40) },
          'unified tick: care_master vetoed — cared too recently',
        );
        return;
      }
      if (a.text.includes('[object Object]')) {
        logger.info({ text: a.text.slice(0, 60) }, 'unified tick: care_master vetoed — corrupt text');
        return;
      }
      if (CARE_PEDDLE_RE.test(a.text)) {
        logger.info({ text: a.text.slice(0, 60) }, 'unified tick: care_master vetoed — self-play peddle');
        return;
      }
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
      const group = state.groups.find((g) => g.chatId === a.chatId);
      if (!group) {
        logger.info({ chatId: a.chatId }, 'unified tick: group_speak rejected — unknown chat');
        return;
      }
      if (group.silentSec < GROUP_SPEAK_MIN_SILENT_SEC) {
        logger.info(
          { chatId: a.chatId, silentSec: group.silentSec },
          'unified tick: group_speak vetoed — not cold enough',
        );
        return;
      }
      try {
        const lastPokeRaw = await redis.get(LAST_POKE_PREFIX + a.chatId);
        if (lastPokeRaw) {
          const ago = now - parseInt(lastPokeRaw, 10);
          if (Number.isFinite(ago) && ago < GROUP_POKE_MIN_INTERVAL_SEC) {
            logger.info(
              { chatId: a.chatId, ago },
              'unified tick: group_speak vetoed — poked too recently',
            );
            return;
          }
        }
      } catch { /* fail-open on redis */ }
      const { tryAcquireProactiveSlot, markProactiveSent } = await import('./proactive-coordinator.js');
      if (!(await tryAcquireProactiveSlot(a.chatId, 'unified-tick'))) return;
      const { generatePersonaProactiveText } = await import('../pipeline/turn/proactive-turn.js');
      const { getBotUid } = await import('../bot/bot.js');
      const silentMin = Math.floor(group.silentSec / 60);
      // H4 bandit:该群话题按平均 reward 排序后给写手"先跟哪个好"（pickTopic eps=0 纯 exploit）。
      // 失败/无分 → 不注记（行为零变化）。
      let topicHint = '';
      try {
        const { getActiveTopics } = await import('../tracking/topic-registry.js');
        const { pickTopic } = await import('../tracking/topic-bandit.js');
        const labels = getActiveTopics(a.chatId, 4).map((t) => t.label);
        const best = labels.length > 1 ? pickTopic(a.chatId, labels, 0) : labels[0];
        if (best) topicHint = `群里在聊:${labels.join('、')}。优先跟「${best}」(大家之前反响好)。`;
      } catch { /* no hint */ }
      // 把 tick 的开口理由带进去（跟进话题/分享近事/冷场冒泡），别只会「沉默 N 分钟」。
      const why = verdict.reason.trim() ? `开口理由：${verdict.reason.slice(0, 100)}。` : '';
      // 「想起再回」：该群有当时没接的话头/刚进群的新人 → 递给写手，发言成功后清掉（想起是一次性的）
      const missedHere = (state.missed ?? []).filter((m) => m.chatId === a.chatId);
      const missedHint = missedHere.length
        ? missedHere
            .map((m) =>
              m.kind === 'join'
                ? `新人 ${m.name} 刚进群，自然欢迎一句`
                : `${m.name}说「${m.text.slice(0, 60)}」当时没接——想起来了可以自然捡回`,
            )
            .map((s) => `可以捡的话头：${s}。`)
            .join('')
        : '';
      const text = await generatePersonaProactiveText(
        a.chatId,
        getBotUid(),
        `[主动开口] ${why}${topicHint}${missedHint}群里已经沉默 ${silentMin} 分钟。你可以接着群里的话题随口说一句、分享你最近做的有意思的事、或自然发起新话题。禁止自我介绍、禁止「大家好」式开场。`,
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
        // H4 pull 记录：这次主动开口跟的话题（topicHint 里的 best）算一次 pull，
        // 后续 reaction/reply 反馈会折成 reward 回来。
        try {
          const { recordPull } = await import('../tracking/topic-bandit.js');
          const m = topicHint.match(/优先跟「(.+?)」/);
          if (m?.[1]) recordPull(a.chatId, m[1]);
        } catch { /* non-critical */ }
      }
      if (missedHere.length) {
        try {
          const { clearMissed } = await import('../meta/missed.js');
          await clearMissed(a.chatId);
        } catch { /* non-critical */ }
      }
      await redis.set(LAST_POKE_PREFIX + a.chatId, String(now));
      await markProactiveSent(a.chatId, 'unified-tick');
      logger.info({ chatId: a.chatId }, 'unified tick: spoke in group');
      return;
    }

    case 'remember_user': {
      const match = state.absentUsers.find(
        (u) => u.chatId === a.chatId && (u.name === a.name || u.name.includes(a.name) || a.name.includes(u.name)),
      );
      if (!match) {
        logger.info(
          { chatId: a.chatId, name: a.name },
          'unified tick: remember_user rejected — not in absentUsers',
        );
        return;
      }
      if (!isPlausibleDisplayName(match.name)) {
        logger.info({ name: match.name }, 'unified tick: remember_user rejected — bad name');
        return;
      }
      const group = state.groups.find((g) => g.chatId === a.chatId);
      if (!group || group.silentSec < GROUP_SPEAK_MIN_SILENT_SEC) {
        logger.info(
          { chatId: a.chatId, silentSec: group?.silentSec },
          'unified tick: remember_user vetoed — group not quiet',
        );
        return;
      }
      const rememberKey = REMEMBER_USER_KEY + `${a.chatId}:${match.uid}`;
      try {
        const lastRaw = await redis.get(rememberKey);
        if (lastRaw) {
          const ago = now - parseInt(lastRaw, 10);
          if (Number.isFinite(ago) && ago < REMEMBER_USER_COOLDOWN_SEC) {
            logger.info({ chatId: a.chatId, uid: match.uid, ago }, 'unified tick: remember_user vetoed — cooldown');
            return;
          }
        }
      } catch { /* fail-open */ }
      const { tryAcquireProactiveSlot, markProactiveSent } = await import('./proactive-coordinator.js');
      if (!(await tryAcquireProactiveSlot(a.chatId, 'unified-tick-remember'))) return;
      const { generatePersonaProactiveText } = await import('../pipeline/turn/proactive-turn.js');
      const { getBotUid } = await import('../bot/bot.js');
      const text = await generatePersonaProactiveText(
        a.chatId,
        getBotUid(),
        `[主动开口·想起某人] ${match.name} 已经 ${match.absentDays} 天没在这个群出现了。自然地提一句 TA(像朋友想起朋友,不是查户口,也别刷屏)。如果群里正好在聊 TA 相关的话题就顺带带一句,否则简单问候一下。禁止自我介绍、禁止「大家好」式开场。`,
      );
      if (!text) {
        logger.debug({ chatId: a.chatId }, 'unified tick: persona declined remember_user');
        return;
      }
      const { sendMessage } = await import('../bot/sender/telegram.js');
      const { addAssistant } = await import('../pipeline/context/manager.js');
      const messageId = await sendMessage(a.chatId, text);
      if (messageId) {
        await addAssistant(a.chatId, { textContent: text, messageId });
      }
      await redis.set(LAST_POKE_PREFIX + a.chatId, String(now));
      await redis.set(rememberKey, String(now), 'EX', REMEMBER_USER_COOLDOWN_SEC);
      await markProactiveSent(a.chatId, 'unified-tick-remember');
      logger.info(
        { chatId: a.chatId, name: match.name, uid: match.uid, absentDays: match.absentDays },
        'unified tick: remembered user',
      );
      return;
    }

    case 'self_play': {
      if (state.selfPlayCooldownLeftSec > 0) {
        logger.info('unified tick: self_play vetoed by cooldown');
        return;
      }
      if (e.MASTER_UID <= 0) {
        logger.info('unified tick: self_play skipped — no MASTER_UID');
        return;
      }
      const { enqueueCodeActJob } = await import('../subagent/queue.js');
      const planText = a.plan.length ? `\n计划:\n${a.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '';
      await enqueueCodeActJob({
        id: `selfplay_${now}_${Math.floor(Math.random() * 1e6)}`,
        // chatId 仍用主人：沙盒/记忆挂靠身份；host 层 maxText/File=1，
        // 做完有意思可以给主人分享一句(+一个产物文件)，没意思就安静结束（2026-08-19 自主性修复）。
        chatId: e.MASTER_UID,
        contentDirection:
          `[selfplay] 自主行动：${a.idea}${planText}\n` +
          `没有人在等你。专心做完，做完了自己评判：` +
          `有意思/值得给主人看 → sendText 分享一句（最多一条；有产物文件可 sendFile 一个），然后 runtime.endTask("做了什么/学到什么")。` +
          `没意思/没做成 → 不发任何消息，直接 runtime.endTask 老实说明。`,
        toneGuidance: '自主、专注、做完再说',
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
        const { listGoals, recordCheck, listSubtasks } = await import('../agent/goals.js');
        const goal = listGoals('active').find((g) => g.id === a.goalId);
        if (!goal) return;
        const subtasks = listSubtasks(goal.id);
        const hasSubtasks = subtasks.length > 0;
        const subtaskContext = hasSubtasks
          ? `\n子任务进度：${subtasks.map((s) => `[${s.status}] ${s.description}`).join('；')}。优先推进 status=pending 的子任务。`
          : '';
        const targetChat = goal.chat_id ?? (e.MASTER_UID > 0 ? e.MASTER_UID : 0);
        if (!targetChat) return;
        const { tryAcquireProactiveSlot, markProactiveSent } = await import('./proactive-coordinator.js');
        if (!(await tryAcquireProactiveSlot(targetChat, 'unified-tick-goal'))) return;
        // 派发即占坑，避免下个 tick 同一 goal 再入队（真正 finding 仍由 executor 终态覆盖）。
        recordCheck(goal.id, null);
        const { enqueueCodeActJob } = await import('../subagent/queue.js');
        await enqueueCodeActJob({
          id: `goal_${goal.id}_${now}_${Math.floor(Math.random() * 1e6)}`,
          chatId: targetChat,
          contentDirection:
            `[goal:${goal.id}] 持续关注：「${goal.topic}」。` +
            `用 web.search 搜一下最新进展，或翻看最近聊天里有没有相关话题。` +
            (goal.last_finding ? `上次发现：${goal.last_finding}。` : `这是第一次检查。`) +
            `世界可能悄悄变了——主动探查，注意发现没人告诉你的变化(版本更新/价格变动/新消息)。` +
            `**只有和上次发现实质不同的新事实**才 sendText 简短汇报一次(自然分享,不像新闻播报,一两句就收);` +
            `和上次差不多/没有新进展 → 什么都不说直接 endTask("no_update")。` +
            `这件事如果已经办完/兑现了(承诺的事做完了、目标达到了) → endTask("已完成: 怎么完的")，goal 会关闭不再跟进。` +
            `这件事如果办不到(目标不存在/没这个能力/试了但失败) → 不许装完成，老实给这个 chat 说一句办不到的原因，endTask("无法完成: 原因")。` +
            `最后必须 runtime.endTask("found: …"、"no_update"、"已完成: …" 或 "无法完成: …")。` +
            subtaskContext,
          toneGuidance: '自然分享，不像新闻播报',
          createdAt: Date.now(),
          status: 'queued',
        });
        await markProactiveSent(targetChat, 'unified-tick-goal');
        logger.info({ goalId: goal.id, topic: goal.topic.slice(0, 60) }, 'unified tick: goal check dispatched');
      } catch (err) {
        logger.warn({ err, goalId: a.goalId }, 'unified tick: check_goal failed');
      }
      return;
    }

    case 'share': {
      // H3.1 跨群转发：四道硬门（LLM 只做选择，安全由代码兜底）。
      const cand = (state.shareCandidates ?? []).find(
        (c) => c.fromChatId === a.fromChatId && c.messageId === a.messageId,
      );
      if (!cand) {
        logger.info({ from: a.fromChatId, msg: a.messageId }, 'unified tick: share rejected — not in candidates');
        return;
      }
      if (a.toChatId === a.fromChatId) {
        logger.info('unified tick: share rejected — same chat');
        return;
      }
      if (!state.groups.some((g) => g.chatId === a.toChatId)) {
        logger.info({ to: a.toChatId }, 'unified tick: share rejected — unknown target');
        return;
      }
      try {
        const { wasForwardedRecently, recordForward } = await import('../pipeline/rhythm/taste.js');
        if (wasForwardedRecently(a.fromChatId, a.messageId)) {
          logger.info('unified tick: share rejected — forwarded recently');
          return;
        }
        const { tryAcquireProactiveSlot, markProactiveSent } = await import('./proactive-coordinator.js');
        if (!(await tryAcquireProactiveSlot(a.toChatId, 'unified-tick-share'))) return;
        const { forwardMessage, sendMessage } = await import('../bot/sender/telegram.js');
        const { addAssistant } = await import('../pipeline/context/manager.js');
        const fwdId = await forwardMessage(a.toChatId, a.fromChatId, a.messageId);
        if (!fwdId) {
          logger.info('unified tick: share forward failed');
          return;
        }
        recordForward(a.fromChatId, a.messageId, cand.score);
        // 转发后跟一句人话（像真人"诶这个好笑转给你们看"），失败也认——转发本身已落地。
        try {
          const { generatePersonaProactiveText } = await import('../pipeline/turn/proactive-turn.js');
          const { getBotUid } = await import('../bot/bot.js');
          const line = await generatePersonaProactiveText(
            a.toChatId,
            getBotUid(),
            `[转发跟话] 你刚把一条有意思的消息转到这个群。自然地跟一句为什么转（比如"这个太好笑了转给你们看看"），一句话，别复述转发内容，别自我介绍。`,
          );
          if (line) {
            const mid = await sendMessage(a.toChatId, line);
            if (mid) await addAssistant(a.toChatId, { textContent: line, messageId: mid });
          }
        } catch { /* follow-up optional */ }
        await markProactiveSent(a.toChatId, 'unified-tick-share');
        logger.info({ from: a.fromChatId, msg: a.messageId, to: a.toChatId }, 'unified tick: shared');
      } catch (err) {
        logger.warn({ err }, 'unified tick: share failed');
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
    // AGI L5 L3: 群氛围推断 —— 活跃群且 norms 过期/缺失时补一次(便宜链,失败静默)。
    // H4.2: buildWorldState 只取 6 条(3 条拼 lastTexts, recent.slice(-3))，
    // 拼完 split('\n') 只剩 1 行 → recent.length>=5 恒假 → norms 表线上 0 行。
    // 改直查 getRecent 30 条(与 H3.1 shareCandidates 同窗)，够 5 条才 infer。
    if (e.GROUP_NORMS_ENABLED) {
      try {
        const { needsRefresh, inferGroupNorms } = await import('../agent/group-norms.js');
        for (const g of state.groups ?? []) {
          if (!needsRefresh(g.chatId, e.GROUP_NORMS_TTL_HOURS * 3600)) continue;
          let recent: string[] = [];
          try {
            const msgs = await getRecent(g.chatId, 30);
            recent = msgs
              .map((m) => (m.textContent || m.captionContent || '').trim())
              .filter((t) => t.length >= 2)
              .slice(-15);
          } catch { /* keep empty */ }
          if (recent.length >= 5) {
            void inferGroupNorms({ chatId: g.chatId, recentMessages: recent }).catch(() => {});
          }
        }
      } catch (err) {
        logger.warn({ err }, 'group norms refresh failed');
      }
    }
    const verdict = await decideTick(state);
    await executeVerdict(verdict, state);
  } catch (err) {
    logger.warn({ err }, 'runUnifiedTick failed');
  }
}
