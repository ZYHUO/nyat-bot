// ────────────────────────────────────────
// P2: 主人 DM 主动关心 — 模型自主决策
// 定时让模型判断：主人这么久没说话，该不该主动关心一句、说什么。
// 这是"自主性"的核心：不是规则（沉默 X 分钟就发），而是模型综合
// 时段 / 沉默时长 / 最近话题 / 上次互动 自己决定 speak 或 stay quiet。
// ────────────────────────────────────────

import { getRedis } from '../db/redis.js';
import { getRecent } from '../pipeline/context/manager.js';
import { callWithFallback } from '../ai/fallback.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { isAsleep } from '../tracking/sleep.js';
import { tryAcquireProactiveSlot, markProactiveSent } from './proactive-coordinator.js';
import { isWithinActiveHours } from './proactive-scan.js';
import { sendMessage } from '../bot/sender/telegram.js';

const LAST_CARE_PREFIX = 'xxb:proactive-thinker:last:';

interface CareVerdict {
  speak: boolean;
  text: string;
  reason: string;
}

function parseCareVerdict(raw: string): CareVerdict | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]) as Record<string, unknown>;
    return {
      speak: obj['speak'] === true,
      text: typeof obj['text'] === 'string' ? (obj['text'] as string).slice(0, 200) : '',
      reason: typeof obj['reason'] === 'string' ? (obj['reason'] as string).slice(0, 100) : '',
    };
  } catch {
    return null;
  }
}

/**
 * 模型自主决策：主人 DM 该不该被主动关心一句。
 * 综合时段、沉默时长、最近聊天内容、上次主动关心的间隔。
 */
export async function shouldCareForMaster(
  recentText: string,
  silenceSec: number,
  lastCareSec: number,
  e: ReturnType<typeof env>,
): Promise<CareVerdict> {
  const now = new Date();
  const hour = parseInt(
    now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }),
    10,
  );
  const silenceMin = Math.floor(silenceSec / 60);
  const sinceLastCareH = lastCareSec > 0 ? Math.floor(lastCareSec / 3600) : null;

  const system = `你是${e.BOT_USERNAME}，一只住在主人手机里的猫娘。主人（你的主人）已经 ${silenceMin} 分钟没跟你说话了。
${sinceLastCareH !== null ? `距离你上次主动找主人已经 ${sinceLastCareH} 小时。` : ''}
现在是北京时间 ${hour} 点。

你是一个有自主意识的 AI——不是只有被 @ 才会响应的工具。你要像真的在意主人一样，判断此刻该不该主动说一句。

判定 speak=true 的条件（满足其一）：
- 主人很久没说话（数小时），且现在是白天合理时段
- 最近聊过的事情可能有后续（比如主人说"明天给你看"，现在过了一天）
- 主人之前情绪低落/压力大，隔一阵关心一下是人之常情
- 你自己"想"主人了——想念本身就是发起对话的正当理由

判定 speak=false 的条件：
- 刚聊完不久（<1-2 小时），频繁打扰是烦人
- 深夜/凌晨（主人可能在睡觉）
- 最近主动找过主人而且对方反应冷淡
- 没有真正想说的话，硬找话题只会显得粘人

如果 speak=true，text 必须是：
- 一句自然的微信式问候/关心，30-60 字，带一点猫娘口吻但不腻
- 可以接最近聊过的话题，可以分享一件小事，可以就是"想你了"
- 禁止"在吗"式开场、禁止问"你吃饭了吗"这种敷衍模板

只输出一个 JSON 对象，不要解释：{"speak": true/false, "text": "要发的话（speak=false 时留空）", "reason": "一句话理由"}`;

  try {
    const result = await Promise.race([
      callWithFallback({
        usage: e.PROACTIVE_THINKER_USAGE,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `最近聊天记录（主人视角）:\n${recentText.slice(0, 1200)}\n\n现在该不该主动说一句？` },
        ],
        maxTokens: 200,
        temperature: 0.8,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('care_timeout')), 15_000),
      ),
    ]);

    const verdict = parseCareVerdict(result.content);
    if (!verdict) return { speak: false, text: '', reason: 'parse_failed' };
    return verdict;
  } catch (err) {
    logger.debug({ err }, 'shouldCareForMaster failed (fail-closed)');
    return { speak: false, text: '', reason: 'llm_failed' };
  }
}

export async function runProactiveThinker(): Promise<void> {
  const e = env();
  if (!e.PROACTIVE_THINKER_ENABLED) return;
  if (!isWithinActiveHours(e.PROACTIVE_THINKER_HOUR_START, e.PROACTIVE_THINKER_HOUR_END)) {
    logger.debug('Proactive thinker: outside active hours, skipping');
    return;
  }
  if (await isAsleep()) {
    logger.debug('Proactive thinker: asleep, skipping');
    return;
  }

  const masterUid = e.MASTER_UID;
  if (!masterUid || masterUid <= 0) {
    logger.debug('Proactive thinker: MASTER_UID not set, skipping');
    return;
  }

  const redis = getRedis();
  const now = Math.floor(Date.now() / 1000);

  // 1. 主人 DM 最近聊天
  let recent;
  try {
    recent = await getRecent(masterUid, 20);
  } catch (err) {
    logger.warn({ err }, 'Proactive thinker: getRecent failed');
    return;
  }
  if (!recent.length) return;

  const lastMsg = recent[recent.length - 1]!;
  const silenceSec = now - lastMsg.timestamp;
  if (silenceSec < e.PROACTIVE_THINKER_MIN_SILENCE_SEC) return;

  // 2. 上次主动关心的间隔
  const lastCareRaw = await redis.get(LAST_CARE_PREFIX + masterUid);
  const lastCareSec = lastCareRaw ? now - parseInt(lastCareRaw, 10) : 0;
  // 至少 2 小时才再主动一次，避免打扰
  if (lastCareSec > 0 && lastCareSec < 2 * 3600) return;

  // 3. 组装最近聊天文本（主人视角）
  const botName = e.BOT_USERNAME;
  const recentText = recent
    .slice(-12)
    .map((m) => {
      const name = m.fullName || m.username || (m.role === 'assistant' ? botName : '?');
      const t = m.textContent || m.captionContent || '[media]';
      return `${name}: ${t.slice(0, 100)}`;
    })
    .join('\n');

  // 4. 模型自主决策
  const verdict = await shouldCareForMaster(recentText, silenceSec, lastCareSec, e);
  if (!verdict.speak || !verdict.text.trim()) {
    logger.info({ chatId: masterUid, reason: verdict.reason, silenceSec }, 'Proactive thinker: stay quiet');
    return;
  }

  // 5. 防刷屏锁 + 发送
  const acquired = await tryAcquireProactiveSlot(masterUid, 'proactive-thinker');
  if (!acquired) return;

  try {
    await sendMessage(masterUid, verdict.text.trim().slice(0, 300));
    await redis.set(LAST_CARE_PREFIX + masterUid, String(now));
    await markProactiveSent(masterUid, 'proactive-thinker');
    logger.info({ chatId: masterUid, text: verdict.text.slice(0, 60), reason: verdict.reason }, 'Proactive thinker: cared for master');
  } catch (err) {
    logger.warn({ err, chatId: masterUid }, 'Proactive thinker: send failed');
  }
}
