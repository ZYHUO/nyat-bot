// ────────────────────────────────────────
// Bot Command Learner — 从聊天观察学"其他 bot 的命令怎么用"
// ────────────────────────────────────────
//
// 从 Redis 上下文里挖"有人发 /命令 → 某 bot 回应"的配对(回执的
// inlineKeyboard 直接定 output_type:callback 按钮后的数据 bot 够不到),
// LLM 抽用法/场景/needs_reply/needs_admin,累积进 bot_command_profiles。
// 水位防同一批消息反复计数。纯观察,不发任何命令。

import { getRedis } from '../db/redis.js';
import { getRecent } from '../pipeline/context/manager.js';
import { callWithFallback } from '../ai/fallback.js';
import { loadCachedPrompt } from '../shared/config.js';
import { upsertCommandObservation } from './bot-command-store.js';
import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import type { FormattedMessage } from '../shared/types.js';

const WM_KEY = (chatId: number): string => `xxb:botcmd:wm:${chatId}`;
const PAIR_WINDOW = 6;      // 命令后多少条内的 bot 回应算配对
const PAIR_WINDOW_SEC = 180;

interface Pair {
  bot: string;
  command: string;     // 含前导斜杠,小写,去 @
  args: string;
  triggerByBot: boolean;
  outputType: string;
  responseText: string;
}

/** 从回执消息推回执形态 */
function deriveOutputType(responses: FormattedMessage[]): string {
  let hasText = false, hasUrl = false, hasCallback = false, hasMedia = false;
  for (const m of responses) {
    if ((m.textContent || m.captionContent || '').trim().length > 3) hasText = true;
    if (m.audioFileId || m.voiceFileId || m.documentFileId || m.imageFileId || m.videoFileId) hasMedia = true;
    for (const b of m.inlineKeyboard ?? []) {
      if (b.url) hasUrl = true;
      else if (b.callbackData) hasCallback = true;
    }
  }
  if (hasText && hasCallback) return 'mixed';
  if (hasText) return 'text';
  if (hasMedia) return 'media';
  if (hasUrl) return 'url';
  if (hasCallback) return 'callback';
  return 'unknown';
}

/** 在一段消息序列里挖"命令→bot 回应"配对(命令消息 id > watermark 才算新) */
// 通用/噪声命令:不值得学,且最容易把后面无关 bot 的发言误配进来(review #10)
const GENERIC_COMMANDS = new Set(['/start', '/help', '/rules', '/menu', '/about', '/ping', '/id', '/settings']);

/**
 * 挖"命令→bot 回应"配对。
 * safeMaxMid = 已"结清"(回应窗口完整可观测)的命令里最大的 messageId ——
 * 只把水位推进到这里,防止窗口边缘"命令在、回应还没到"的命令被永久跳过(#8)。
 */
export function minePairs(msgs: FormattedMessage[], botUid: number, sinceMid: number): { pairs: Pair[]; safeMaxMid: number } {
  const pairs: Pair[] = [];
  let safeMaxMid = sinceMid;
  const lastTs = msgs.length > 0 ? msgs[msgs.length - 1]!.timestamp : 0;
  // 位置/时间上回应窗口是否已完整可观测(后面消息够多 或 已过去足够时间)
  const positionSettled = (i: number, m: FormattedMessage): boolean =>
    i + PAIR_WINDOW < msgs.length || lastTs - m.timestamp > PAIR_WINDOW_SEC;
  const bump = (mid: number): void => { if (mid > safeMaxMid) safeMaxMid = mid; };

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    const text = (m.textContent || '').trim();
    const cm = text.match(/^(\/[a-zA-Z][a-zA-Z0-9_]{0,30})(?:@(\w+))?(?:\s+([\s\S]{0,80}))?/);
    if (!cm) continue;
    if (m.messageId <= sinceMid) continue;
    const command = cm[1]!.toLowerCase();
    const targetHint = cm[2];
    const args = (cm[3] || '').trim();
    if (GENERIC_COMMANDS.has(command)) { if (positionSettled(i, m)) bump(m.messageId); continue; }
    // 找后续窗口内的 bot 回应(优先 reply 到本命令的;否则取首个候选 bot)
    const responses: FormattedMessage[] = [];
    let respBot = '';
    for (let j = i + 1; j < Math.min(i + 1 + PAIR_WINDOW, msgs.length); j++) {
      const n = msgs[j]!;
      if (n.timestamp - m.timestamp > PAIR_WINDOW_SEC) break;
      if (n.isBot && n.uid !== botUid && n.username) {
        if (targetHint && n.username.toLowerCase() !== targetHint.toLowerCase()) continue;
        // 该 bot 回应明确 reply 了别的消息(不是本命令)→ 不是对本命令的回应,跳过
        if (n.replyTo && n.replyTo.messageId && n.replyTo.messageId !== m.messageId) continue;
        if (respBot && n.username !== respBot) continue;
        respBot = n.username;
        responses.push(n);
      }
    }
    const pairFormed = !!respBot && responses.length > 0;
    // 结清 = 配上了对(已拿到回应) 或 窗口已确定过完。只对结清的命令推进水位,
    // 窗口边缘"命令在、回应还没到"的留到下个 tick 重挖(review #8)。
    if (pairFormed || positionSettled(i, m)) bump(m.messageId);
    if (!pairFormed) continue;
    pairs.push({
      bot: respBot,
      command,
      args,
      triggerByBot: !!m.isBot,
      outputType: deriveOutputType(responses),
      responseText: responses.map((r) => r.textContent || r.captionContent || '').filter(Boolean).join(' ⏎ ').slice(0, 300),
    });
  }
  return { pairs, safeMaxMid };
}

interface ExtractedProfile {
  bot: string; command: string;
  usage_syntax?: string; use_scenario?: string;
  needs_reply?: boolean; needs_admin?: boolean | null; output_type?: string;
}

export function parseExtraction(raw: string): ExtractedProfile[] {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is ExtractedProfile =>
      !!x && typeof x === 'object' && typeof (x as ExtractedProfile).bot === 'string' && typeof (x as ExtractedProfile).command === 'string');
  } catch {
    return [];
  }
}

/** 学一个 chat:挖新配对 → LLM 抽档案 → upsert。返回学到的命令数。 */
export async function learnChatBotCommands(chatId: number, botUid: number): Promise<number> {
  const redis = getRedis();
  const sinceMid = Number((await redis.get(WM_KEY(chatId)).catch(() => null)) ?? 0);
  const msgs = await getRecent(chatId, 120);
  if (msgs.length === 0) return 0;

  const { pairs, safeMaxMid } = minePairs(msgs, botUid, sinceMid);
  const advanceWatermark = async (): Promise<void> => {
    if (safeMaxMid > sinceMid) await redis.set(WM_KEY(chatId), String(safeMaxMid), 'EX', 30 * 86400).catch(() => {});
  };
  // 没有配对:没有要 LLM 抽取的东西,直接把水位推进到已结清处(无损)
  if (pairs.length === 0) { await advanceWatermark(); return 0; }

  // 去重到 (bot, command),保留证据样本 + 合并 output_type
  const byCmd = new Map<string, Pair[]>();
  for (const p of pairs) {
    const k = `${p.bot}|${p.command}`;
    (byCmd.get(k) ?? byCmd.set(k, []).get(k)!).push(p);
  }

  const samples = [...byCmd.values()].flat().map((p) =>
    `- ${p.triggerByBot ? '[bot]' : '[人]'} 发 ${p.command}${p.args ? ' ' + p.args : ''} → ${p.bot}(bot): ${p.responseText || '(无文本)'}`
  ).join('\n').slice(0, 4000);

  let extracted: ExtractedProfile[] = [];
  try {
    // 用函数式 replacement:samples/bot_name 含 $&、$' 等会被 String.replace 当
    // 特殊替换模式吃掉(review #3:股价/格式化回执里 $ 很常见)
    const name = env().BOT_NICKNAMES[0] || env().BOT_USERNAME;
    const tmpl = loadCachedPrompt('system/extract_bot_commands.md')
      .replace('{bot_name}', () => name)
      .replace('{samples}', () => samples);
    const res = await callWithFallback({
      // 离线学习:可路由到 mundo(深推理,把观察提炼成用法/场景更准)。mundo 的
      // per-provider maxTokens(16000)会盖过下面的 800、防推理模型截断成空;兜底
      // 模型仍用 800。默认 'summarize' 时行为不变。
      usage: env().BOT_COMMAND_LEARN_USAGE,
      messages: [{ role: 'user', content: tmpl }],
      maxTokens: 800,
      temperature: 0.2,
    });
    extracted = parseExtraction(res.content);
  } catch (err) {
    // 抽取失败:**不推进水位**,下个 tick 重挖这些配对重试(review #1:
    // 否则 LLM 故障期间挖到的命令永久丢失)
    logger.debug({ err, chatId }, 'bot-command-learner: LLM extraction failed');
    return 0;
  }

  let learned = 0;
  for (const e of extracted) {
    // output_type / peer_accepts 用观察证据兜底(比 LLM 猜更可靠)
    const evidence = byCmd.get(`${e.bot}|${e.command.toLowerCase().split('@')[0]}`) ?? [];
    const obsOutput = evidence.find((p) => p.outputType !== 'unknown')?.outputType;
    const triggeredByBot = evidence.some((p) => p.triggerByBot);
    upsertCommandObservation({
      botUsername: e.bot,
      command: e.command,
      usageSyntax: e.usage_syntax,
      useScenario: e.use_scenario,
      needsReply: e.needs_reply,
      needsAdmin: e.needs_admin === null ? undefined : e.needs_admin,
      outputType: e.output_type && e.output_type !== 'unknown' ? e.output_type : obsOutput,
      // 直接观察到"bot 发命令也得到回应" → peer 接受 bot
      peerAcceptsBot: triggeredByBot ? true : undefined,
    });
    learned++;
  }
  // 抽取+upsert 都成功了,这批配对已消化 → 现在才推进水位(review #1)
  await advanceWatermark();
  if (learned > 0) logger.info({ chatId, learned }, 'bot-command-learner: profiles updated');
  return learned;
}
