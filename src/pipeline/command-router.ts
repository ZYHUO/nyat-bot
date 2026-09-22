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
import { incrCounter } from '../metrics/registry.js';
import type { FormattedMessage } from '../shared/types.js';
import type { BotCommandProfile } from '../learners/bot-command-store.js';

interface Match { bot: string; command: string; args: string; }

/** Jev Choice 里代表“以上都不符合”的哨兵选项 key(避开 c0/c1… 真实命令 key)。 */
const JEV_NONE_KEY = '__none__';

/**
 * 本 bot **自己**的斜杠命令。学到别的 bot 有同名命令时，不能凭语义相似就代发。
 *
 * round 5（新 goal，用户："不会用其他 bot 的指令 完全乱来"）。
 *
 * 生产实测两次误代发：
 *   09-21 15:27  chat=-1003821093564  用户说「等下又要签到水句开盲盒了」
 *              -> bot 向 nmnmfunbot 发了 /checkin
 *   09-22 14:31  chat=-1004430867819  用户说「争取以后能有一周的全勤吧」
 *              -> bot 又向 nmnmfunbot 发了 /checkin
 *
 * 两条都**不是**在要求签到，是在闲聊里提到"签到"这件事。
 * 而 \`nmnmfunbot /checkin\` 恰好是 ready 的已学命令，语义一近就代发了。
 *
 * 用户要的是"帮我用别的 bot 的 X 命令"，不是"你听到 X 这个词就去按一次"。
 * 尤其是撞名的那些：本 bot 自己就有 /checkin、/cards、/stats、/game。
 */
const OWN_COMMANDS = new Set([
  '/checkin', '/help', '/status', '/stats', '/muteme', '/unmuteme',
  '/watch', '/game', '/feature', '/setdefault', '/cards', '/wish', '/skill',
]);

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

type JevVerdict =
  | { kind: 'match'; match: Match; latencyMs?: number }
  | { kind: 'none'; latencyMs?: number }
  | { kind: 'unsure'; latencyMs?: number };

/** ready 命令 → Jev Choice 的选项集(反向索引:选项 key → 真实的 bot/command)。 */
function buildJevCriteria(ready: BotCommandProfile[]): { criteria: Record<string, string>; byKey: Map<string, Match> } {
  const criteria: Record<string, string> = {
    [JEV_NONE_KEY]: '以上都不符合:闲聊、打招呼、或这句并没有明确对应上面任何一条命令。',
  };
  const byKey = new Map<string, Match>();
  ready.forEach((p, i) => {
    const key = `c${i}`;
    criteria[key] = `@${p.bot_username} ${p.command_name} ${p.usage_syntax || ''} — ${p.use_scenario || ''}`.trim();
    byKey.set(key, { bot: p.bot_username, command: p.command_name, args: '' });
  });
  return { criteria, byKey };
}

/**
 * 用 Jev 的 Choice 原语做一次“要不要借力 + 借哪条”的定型判断(flag 门控,默认关)。
 *
 * 只判“借哪条命令 / 都不借”;**不取 args**——Jev 返定型答案、不给文本,所以命中的
 * Match.args 恒为空。就绪命令清单里的 needs_reply / needs_admin 已被上游过滤,
 * 空 args 交给 bot-delegation 的成熟度/冷却/安全闸去把最后一关(发 `/cmd@bot`)。
 *
 * 返回值三分:
 *   match  → 一个**确实在 ready 名单里**的 Match(自信命中)。
 *   none   → Jev 很有信心“没有要借的命令”(闲聊等),gating 后可省掉一次 LLM judge。
 *   unsure → 关着 / 失败 / DM / 熔断 / 低置信 / 答非所问 → 交回原 LLM judge 路径
 *            (行为与没接 Jev 时逐字一致——这是所有降级的最终落点)。
 */
async function classifyWithJev(text: string, chatId: number, ready: BotCommandProfile[]): Promise<JevVerdict> {
  const e = env();
  if (!e.JEV_ENABLED) return { kind: 'unsure' };
  try {
    const { callJevChoice } = await import('../ai/jev.js');
    const { criteria, byKey } = buildJevCriteria(ready);
    const ans = await callJevChoice({
      id: 'ROUTE',
      state: text.slice(0, 500),
      question: '群里有人对 bot 说的这句话,最可能是想让 bot 帮忙调用哪一条命令?都不像就选 none,宁可 none 也别硬套。',
      criteria,
      chatId,
    });
    if (!ans) return { kind: 'unsure' };                          // 关着/失败/DM/熔断 → 降级
    if (ans.choice === JEV_NONE_KEY) return { kind: 'none', latencyMs: ans.latencyMs };  // 有信心的“不借”
    if (ans.confidence < e.JEV_MIN_CONFIDENCE) return { kind: 'unsure', latencyMs: ans.latencyMs };  // 没把握 → 大模型判
    const hit = byKey.get(ans.choice);
    if (!hit) return { kind: 'unsure', latencyMs: ans.latencyMs };  // 不在 ready(不应发生)→ 降级
    // round 5：**撞名命令只在显式指定时才代发。**
    //
    // 「等下又要签到水句开盲盒了」这种闲聊里提到签到，不能变成一次真的代发。
    // 判据：消息里必须出现目标 bot 的名字（@bot / bot 用户名本体），
    // 否则一律 unsure → 回落 LLM judge，而 LLM judge 有完整上下文，
    // 比"语义最近"靠谱。
    if (OWN_COMMANDS.has(hit.command.toLowerCase()) && !namesBot(text, hit.bot)) {
      logger.debug({ chatId, bot: hit.bot, cmd: hit.command }, 'command-router: 撞名命令未显式指定 → 不代发');
      return { kind: 'unsure', latencyMs: ans.latencyMs };
    }
    return { kind: 'match', match: hit, latencyMs: ans.latencyMs };
  } catch {
    return { kind: 'unsure' };                                 // Jev 永不拖垮路由
  }
}

async function classify(text: string, chatId: number, ready: BotCommandProfile[]): Promise<Match | null> {
  // 快路径:Jev 结构化 Choice(flag 门控,默认关)。命中 → 直接代发(不带 args);
  // 有信心的“不借” → 直接 null,省掉一次 ~数秒的 LLM judge;其余(关/失败/低置信/
  // 答非所问)→ 落到下面原 LLM judge,行为与没接 Jev 时逐字一致。
  try {
    const v = await classifyWithJev(text, chatId, ready);
    if (v.kind === 'none') {
      // round 12：**info + 计数器**，不只 debug。
      //
      // 这是 Jev 集成的**大头收益**——群里绝大多数消息不借力，以前每条都要烧
      // 一次 ~4.4-6.6s 的 LLM judge，现在 1-2s 定完。而它原来只打 debug，
      // LOG_LEVEL=info 的生产里**完全看不见**，于是"Jev 到底省了几次、
      // 省了多少时间"无法回答。
      //
      // 这个会话已经为"量的东西缺分母"交过五次学费（round 26/81/96/125/128），
      // 每次都是同一个形状：机制在工作，但没有计数，于是无法证明它工作。
      incrCounter('command_router_jev_none_total', { chat: chatId });
      logger.info({ chatId, latencyMs: v.latencyMs }, 'command-router: jev → 无命令,跳过 LLM judge');
      return null;
    }
    if (v.kind === 'match') {
      incrCounter('command_router_jev_match_total', { chat: chatId });
      logger.info({ chatId, bot: v.match.bot, cmd: v.match.command }, 'command-router: jev matched command(LLM judge skipped)');
      return v.match;
    }
    // v.kind === 'unsure' → 继续走下面的 LLM judge。
  } catch {
    // 双保险:分类快路径出错绝不影响主流程,继续走 LLM judge。
  }

  try {
    const r = await callWithFallback({
      usage: 'judge',
      // round 26: 去掉写死的 maxTokens: 80 —— 这是全部里最小的一个,
      // reasoning 模型的思维链连 80 的零头都不到。同 round 19/26 一路。
      temperature: 0,
      // round 4：原来没设 maxTimeoutMs，用 judge usage 自己的 45s。它 await 在
      // `tryMetaIngressIntercepts` 的**同步路径**上——排在 sleep gate **之前**
      // （message.ts:280 < :299）。provider 一慢，每一条入站消息都先在
      // 分类这儿卡最多 45s，连"睡着了该静默"都排不到。
      // 实测 2026-09-22 深夜：两条授权群消息进来后，日志停在 message in，
      // 后面什么都不打，HTTP /health 20s 不响应。
      // 分类只是"要不要借别的 bot 办事"的一个前置筛选，8s 足够；
      // 超时就当不匹配，让消息正常走下去。
      maxTimeoutMs: 8_000,
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

    const match = await classify(text, chatId, ready);
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

/**
 * 这句话有没有**显式点到**目标 bot。
 *
 * 两种都算：@bot / bot 用户名本体（去掉 _bot 后缀后长度 >=3 才认，
 * 否则 "uzu" 这种太短的词会误命中）。都不中就是"只在聊那个话题，
 * 没在指挥那个 bot"。
 *
 * round 5 加，给撞名命令的守卫用。
 */
function namesBot(text: string, bot: string): boolean {
  const b = bot.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes('@' + b)) return true;
  const stem = b.replace(/_bot$/, '');
  if (stem.length >= 3 && t.includes(stem)) return true;
  return false;
}
