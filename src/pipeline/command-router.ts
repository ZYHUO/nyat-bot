// ────────────────────────────────────────
// 借力其他 bot:「学习 + 调用 agent」的**调用**半 —— 意图 → 已学命令 路由
// ────────────────────────────────────────
// 学习侧(cron)把群里其他 bot 的命令学成 profile(实测已学 60+,ready 12);但
// 「调用」此前只作为 agentic 工具存在 —— 大多数回复走 direct 路径够不到,且工具
// 不告诉模型学过哪些命令 → 学了几乎不用(全量日志才 2 次代发)。
//
// 这里补上专职的「调用路由」:有人 @bot / 回复 bot 且意图**明确**匹配某条 ready
// 命令时,用一次廉价 LLM 判定、命中就代发(executeUseBotCommand 的成熟度/权限/
// 冷却/并发/安全闸全部保留)。保守触发:仅点名/回复 bot(与 nl-commands 一致),
// **不**主动扫全群。默认关(BOT_COMMAND_ROUTER_ENABLED),依赖 BOT_DELEGATION_ENABLED。

import { env } from '../env.js';
import { logger } from '../shared/logger.js';
import { callWithFallback } from '../ai/fallback.js';
import type { FormattedMessage } from '../shared/types.js';
import type { BotCommandProfile } from '../learners/bot-command-store.js';

interface Match { bot: string; command: string; args: string; }

const CLASSIFY_SYS =
  '你在判断群友对 bot 说的一句话,是不是想让 bot 去帮忙调用「群里其他 bot 的某条已知命令」。\n' +
  '**可用命令**(每行:@bot 命令 语法 — 用途):\n{list}\n\n' +
  '规则:只有用户这句话的意图**明确、自然地**对应上面**某一条**命令(不是勉强硬套)才算命中。\n' +
  '闲聊、打招呼、对 bot 本身说话、找不到贴切对应的,一律不命中。\n' +
  '命中就抽出命令和参数(参数从用户话里取,如 IP / 歌名 / 链接 / 用户名;没有就空)。\n' +
  '只输出 JSON:命中 `{"bot":"用户名不带@","command":"/xxx","args":"参数或空"}`;不命中 `{"match":false}`。\n' +
  '**宁可 false 不硬套**,拿不准就 false。';

function buildList(ready: BotCommandProfile[]): string {
  return ready
    .map((p) => `- @${p.bot_username} ${p.command_name} ${p.usage_syntax || ''} — ${p.use_scenario || ''}`.trim())
    .join('\n');
}

async function classify(text: string, ready: BotCommandProfile[]): Promise<Match | null> {
  try {
    const r = await callWithFallback({
      usage: 'judge',
      maxTokens: 80,
      temperature: 0,
      messages: [
        { role: 'system', content: CLASSIFY_SYS.replace('{list}', buildList(ready)) },
        { role: 'user', content: text.slice(0, 500) },
      ],
    });
    const m = r.content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]) as { match?: boolean; bot?: string; command?: string; args?: string };
    if (o.match === false || !o.bot || !o.command) return null;
    // 只接受确实在 ready 名单里的组合(防模型编命令)
    const bot = o.bot.replace(/^@/, '').toLowerCase();
    const cmd = o.command.trim().toLowerCase().split('@')[0]!;
    const hit = ready.find((p) => p.bot_username.toLowerCase() === bot && p.command_name.toLowerCase() === cmd);
    if (!hit) return null;
    return { bot: hit.bot_username, command: hit.command_name, args: (o.args || '').trim() };
  } catch {
    return null;
  }
}

/**
 * @bot/回复bot 的消息 → 若意图明确匹配某条 ready 已学命令,代发之。
 * 返回 true = 已代发(短路正常回复);false = 没匹配/没发成(交给正常回复)。
 */
export async function routeLearnedCommand(chatId: number, formatted: FormattedMessage): Promise<boolean> {
  try {
    const e = env();
    if (!e.BOT_COMMAND_ROUTER_ENABLED || !e.BOT_DELEGATION_ENABLED) return false;
    if (chatId >= 0 || formatted.isBot) return false; // 群聊 only
    const text = (formatted.textContent || formatted.captionContent || '').trim();
    if (text.length < 3) return false;

    const { listAllProfiles } = await import('../learners/bot-command-store.js');
    // 只在 ready、且不需要管理员/不需要回复某条消息的(那些代发也会被闸拦)里匹配。
    const ready = listAllProfiles(100).filter((p) => p.status === 'ready' && !p.needs_admin && !p.needs_reply);
    if (ready.length === 0) return false;

    const match = await classify(text, ready);
    if (!match) return false;

    const { tryDelegateCommand } = await import('./tools/bot-delegation.js');
    const r = await tryDelegateCommand(chatId, match.bot, match.command, match.args);
    if (r.sent) {
      logger.info(
        { chatId, uid: formatted.uid, bot: match.bot, cmd: match.command, args: match.args },
        'command-router: delegated learned command',
      );
      return true; // 已代发 → 短路正常回复(代发本身就是这次的响应)
    }
    // 闸拦/冷却/并发 → 不短路,交给正常回复(bot 会正常聊或告诉用户)
    return false;
  } catch (err) {
    logger.debug({ err, chatId }, 'routeLearnedCommand failed (non-critical)');
    return false;
  }
}
