// ────────────────────────────────────────
// Topic scan cron — 廉价 LLM 抽取各活跃群「此刻在聊什么」,喂话题注册表
// ────────────────────────────────────────
//
// 每 TOPIC_SCAN_INTERVAL_MIN 分钟:对每个活跃群,用一次便宜调用(judge 档)从最近消息里
// 提一个当前话题短标签 → observeTopic;再 tickLifecycle 推进生命周期(active→cooling→dead→清理)。
// 抽取时把已有话题喂给模型,让它「还在聊就返回原标签」,避免近义话题爆炸。

import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { getRecent } from '../pipeline/context/manager.js';
import { discoverActiveGroupChats } from './active-hours.js';
import { observeTopic, tickLifecycle, getActiveTopics, pruneDeadTopics } from '../tracking/topic-registry.js';
import { callWithFallback } from '../ai/fallback.js';

const MAX_CHATS_PER_TICK = 20;
const MIN_HUMAN_MSGS = 3;

async function extractTopic(chatId: number): Promise<string | null> {
  const recent = await getRecent(chatId, 15).catch(() => []);
  const humans = recent.filter((m) => !m.isBot && m.role !== 'assistant');
  if (humans.length < MIN_HUMAN_MSGS) return null;
  const ctx = humans
    .slice(-12)
    .map((m) => (m.textContent || m.captionContent || '').slice(0, 80))
    .filter(Boolean)
    .join('\n');
  if (!ctx.trim()) return null;
  const existing = getActiveTopics(chatId, 5).map((t) => t.label);
  const sys =
    '你在追踪一个群此刻在聊什么。读下面最近的消息,用 4-12 个汉字给当前主话题起一个短标签。\n' +
    '规则:\n- 还在聊已有话题之一 → 原样返回那个标签(保持连续)。\n- 话题变了 → 给个新短标签。\n' +
    '- 没有明确话题/纯灌水/只有表情贴纸 → 返回 NONE。\n只输出标签或 NONE,别的都不要。' +
    (existing.length ? `\n已有话题:${existing.join('、')}` : '');
  try {
    const res = await callWithFallback({
      usage: 'judge',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: ctx }],
      // 别写 24。这个 prompt 只要 4-12 个汉字，听上去 24 够用——但 judge usage
      // 会落到 step-3.7-flash 这种 reasoning 模型，思维链先烧 token，24 连一句
      // "让我想想"都不够，content 恒为空，topic-scan 于是静默地什么都产不出
      // （2026-09-21 实测：50 分钟内 193 次空正文，maxTokens 24/48 各 79/73 次）。
      // provider 层已有下限兜底，这里仍写够，别依赖兜底。
      maxTokens: 1200,
      temperature: 0,
      // 纯文本标签输出 —— 关掉 usage 级 jsonMode（response_format 会强制 JSON，坏事）
      jsonMode: false,
      // 每跳 12s。2026-09-21：这里原来没设 maxTimeoutMs，于是用 judge usage 自己的
      // 120s——20 群 × 3 跳 × 120s = 理论上限 **7200s（两小时）**一个 tick。
      // 实测相邻 tick 间隔最大 993s（间隔 480s），即真有 tick 跑了 ~8 分钟。
      // 抽一个 4-12 字的标签不需要 120s；等冷却的重试也不该在这儿等
      // （后台批任务，见 deep-reflection 的 tick 预算）。
      maxTimeoutMs: 12_000,
    });
    const label = (res.content || '').trim().replace(/^[\s["'「『]+|[\s\]"'」』。.!?！？]+$/g, '').slice(0, 40);
    if (!label || label.toUpperCase() === 'NONE' || label.length < 2) return null;
    return label;
  } catch (err) {
    logger.debug({ err, chatId }, 'extractTopic failed (non-critical)');
    return null;
  }
}

export async function runTopicScan(): Promise<void> {
  const e = env();
  if (!e.TOPIC_REGISTRY_ENABLED) return;
  let chats: number[];
  try {
    chats = (await discoverActiveGroupChats()).slice(0, MAX_CHATS_PER_TICK);
  } catch (err) {
    logger.warn({ err }, 'topic-scan: discover failed');
    return;
  }
  // **整 tick 的截止时间。** 2026-09-21：extractTopic 原来没有每跳上限，
  // 用 judge usage 的 120s；20 群 × 3 跳 × 120s = 理论上限两小时。
  // 和 deep-reflection（round 65）同一个病：**单跳合理 × N 群 ≠ 合理。**
  // 到点的群跳过，下一个 tick 自然补上。
  const deadlineMs = Date.now() + Math.max(30_000, env().TOPIC_SCAN_TICK_BUDGET_SEC * 1000);
  let skippedForBudget = 0;

  let observed = 0;
  for (const chatId of chats) {
    if (Date.now() >= deadlineMs) { skippedForBudget++; continue; }
    try {
      const label = await extractTopic(chatId);
      if (label) { observeTopic(chatId, label); observed++; }
      tickLifecycle(chatId); // 推进生命周期,即使本轮没抽到话题(让旧话题正常变冷/消亡)
    } catch (err) {
      logger.debug({ err, chatId }, 'topic-scan: chat failed');
    }
  }
  pruneDeadTopics(); // global sweep:清掉已沉寂群里的 dead 话题(tick 只覆盖活跃群)
  if (chats.length) logger.info({ chats: chats.length, observed, skippedForBudget }, 'Topic scan tick');

  // ── 抽取率告警 ────────────────────────────────────────────────────────
  //
  // 2026-09-21 加。起因是一次读数：102 次 tick、扫了 2040 个群，只抽出 91 个标签
  // （4.5%）。而 `observed` 这个字段**一直都在日志里**，只是没人看——于是一次
  // 每 4 分钟烧 20 次 LLM 调用的 cron，长期以 4.5% 的效率空转，没有任何告警。
  //
  // 病因是 `maxTokens: 24`：topic-scan 只要 4-12 个汉字的标签，听上去 24 够用，
  // 但 judge usage 落到 step-3.7-flash 这种 reasoning 模型，思维链先烧 token，
  // content 恒为空 → extractTopic 返回 null → observed=0。
  //
  // 修复（provider 层的 reasoning token 下限）上线后的同一 cron：20:48:25 那次 tick
  // observed=10、零截断；而之前三次是 1 / 1 / 0，每次都伴随 21 次截断。
  //
  // 阈值取 0.15 而不是 0：群真的没话题时模型会正确返回 NONE，那也是 0。
  // 所以这里不报"本次失败"，报的是**连续**低抽取——单次 0 是正常，
  // 一直 0 说明链路坏了。用进程内计数，不落盘（重启后重新累计，代价小）。
  if (chats.length > 0) {
    const rate = observed / chats.length;
    if (rate < LOW_YIELD_RATE) {
      lowYieldRuns++;
      if (lowYieldRuns === LOW_YIELD_ALERT_AFTER) {
        logger.warn(
          { chats: chats.length, observed, rate: Number(rate.toFixed(3)), consecutive: lowYieldRuns },
          'topic-scan: 连续低抽取——要么群真的没话题，要么 LLM 调用在空转（看 claude: 空正文）',
        );
      }
    } else {
      lowYieldRuns = 0;
    }
  }
}

/** 抽取率低于此值算一次"低产"。 */
const LOW_YIELD_RATE = 0.15;
/** 连续这么多次低产才告警——避免把"群真的冷清"刷成告警。 */
const LOW_YIELD_ALERT_AFTER = 5;
/** 连续低产计数（进程内）。 */
let lowYieldRuns = 0;
