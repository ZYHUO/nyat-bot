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
export function minePairs(msgs: FormattedMessage[], botUid: number, sinceMid: number): { pairs: Pair[]; maxMid: number } {
  const pairs: Pair[] = [];
  let maxMid = sinceMid;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    const text = (m.textContent || '').trim();
    const cm = text.match(/^(\/[a-zA-Z][a-zA-Z0-9_]{0,30})(?:@(\w+))?(?:\s+([\s\S]{0,80}))?/);
    if (!cm) continue;
    if (m.messageId <= sinceMid) continue;
    if (m.messageId > maxMid) maxMid = m.messageId;
    const command = cm[1]!.toLowerCase();
    const targetHint = cm[2];
    const args = (cm[3] || '').trim();
    // 找后续窗口内的 bot 回应
    const responses: FormattedMessage[] = [];
    let respBot = '';
    for (let j = i + 1; j < Math.min(i + 1 + PAIR_WINDOW, msgs.length); j++) {
      const n = msgs[j]!;
      if (n.timestamp - m.timestamp > PAIR_WINDOW_SEC) break;
      if (n.isBot && n.uid !== botUid && n.username) {
        if (targetHint && n.username.toLowerCase() !== targetHint.toLowerCase()) continue;
        if (respBot && n.username !== respBot) continue;
        respBot = n.username;
        responses.push(n);
      }
    }
    if (!respBot || responses.length === 0) continue;
    pairs.push({
      bot: respBot,
      command,
      args,
      triggerByBot: !!m.isBot,
      outputType: deriveOutputType(responses),
      responseText: responses.map((r) => r.textContent || r.captionContent || '').filter(Boolean).join(' ⏎ ').slice(0, 300),
    });
  }
  return { pairs, maxMid };
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

  const { pairs, maxMid } = minePairs(msgs, botUid, sinceMid);
  if (maxMid > sinceMid) await redis.set(WM_KEY(chatId), String(maxMid), 'EX', 30 * 86400).catch(() => {});
  if (pairs.length === 0) return 0;

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
    const tmpl = loadCachedPrompt('system/extract_bot_commands.md')
      .replace('{bot_name}', env().BOT_NICKNAMES[0] || env().BOT_USERNAME)
      .replace('{samples}', samples);
    const res = await callWithFallback({
      usage: 'summarize',
      messages: [{ role: 'user', content: tmpl }],
      maxTokens: 800,
      temperature: 0.2,
    });
    extracted = parseExtraction(res.content);
  } catch (err) {
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
  if (learned > 0) logger.info({ chatId, learned }, 'bot-command-learner: profiles updated');
  return learned;
}
