// ────────────────────────────────────────
// Pipeline stage: command & feature intercepts — mute commands, slash/NL
// command dispatch, sticker dislike, remember/forget,
// ────────────────────────────────────────

import type { FormattedMessage, JudgeResult } from "../../shared/types.js";
import { sender, ADDRESSED_RULES } from "../shared.js";
import {
  muteUser,
  unmuteUser,
} from "../../tracking/user-profile.js";
import {
  lookupSentSticker,
  recordStickerDislike,
  getStickerScore,
} from "../../knowledge/sticker/store.js";
import { env } from "../../env.js";
import { logger } from "../../shared/logger.js";
import { applyMoodEvent } from "../../tracking/mood.js";
import { startGame, stopGame } from "../games/manager.js";
import { createGuessNumberGame } from "../games/guess-number.js";
import { getRedis } from '../../db/redis.js';
import { incrCounter } from '../../metrics/registry.js';

// ── Extracted helper 2: Mute command intercepts ─────────────────────

export async function tryMuteCommandIntercepts(
  chatId: number,
  formatted: FormattedMessage,
  judgeResult: JudgeResult,
): Promise<boolean> {
  if (formatted.isAnonymous) {
    if (judgeResult.rule === "self_mute_request" || judgeResult.rule === "self_unmute_request") {
      await sender.sendDirect(chatId, "频道身份没法用这个命令喵，用个人身份试试~", formatted.messageId);
      return true;
    }
    return false;
  }

  if (chatId >= 0) return false; // group-only

  const rule = judgeResult.rule;

  // mute/unmute 的关键词拦截已下线 —— 改由 directive.ts(回复前 LLM 指令分类)静默执行。
  // 仅保留 /muteme /unmuteme 显式斜杠命令。

  if (rule === "self_mute_request") {
    // 自我 mute:全静默但只 12h,到点自动恢复(免得永久 mute 忘了解)
    muteUser(chatId, formatted.uid, 2, { temporary: true, durationMs: 12 * 60 * 60_000 });
    applyMoodEvent(chatId, -15, "self_mute_request");
    await sender.sendDirect(chatId, "好的，接下来 12 小时本喵不回复你喵~（到点自动恢复，也可发 /unmuteme 提前取消）", formatted.messageId);
    logger.info({ chatId, uid: formatted.uid }, "User self-muted (level 2, 12h)");
    return true;
  }

  if (rule === "self_unmute_request") {
    unmuteUser(chatId, formatted.uid);
    applyMoodEvent(chatId, 5, "self_unmute_request");
    await sender.sendDirect(chatId, "好的，本喵又会回复你的消息了喵~", formatted.messageId);
    logger.info({ chatId, uid: formatted.uid }, "User self-unmuted");
    return true;
  }

  return false;
}

// ── Extracted helper 3: Pre-mute-gate intercepts ────────────────────

/**
 * Dispatch a known command (slash or NL-resolved) to its handler.
 * Returns true if it handled the message. Shared by the slash-command path and
 * the natural-language router so both stay in lockstep.
 */
/** Shared by pipeline pre-mute intercepts and Meta ingress (NL/gacha/game). */
export async function dispatchCommand(
  chatId: number,
  formatted: FormattedMessage,
  cmd: string,
  arg: string,
): Promise<boolean> {
  if (cmd === "/watch" && arg) {
    // 仅 DM(主人)指派 → P4-B goals 表:周期性 CodeAct 去查进展并汇报。
    // 群聊关键词追踪(addWatch)已于 2026-08-19 删除——NL 路由把普通对话
    // 误判成追踪命令（「诺亚帮你留意着」→ 抓到句子碎片当关键词）。
    if (chatId <= 0) return false;
    const { createGoal } = await import("../../agent/goals.js");
    const id = createGoal(
      { topic: arg, origin: "master", chatId },
      env().GOAL_MAX_ACTIVE,
    );
    await sender.sendDirect(
      chatId,
      id
        ? `好喵～本喵会定期盯「${arg}」的最新进展，有发现就告诉你～`
        : `喵…这个目标没立上（本喵最多同时盯 ${env().GOAL_MAX_ACTIVE} 个，或主题太短/重复了），换个说法试试喵～`,
      formatted.messageId,
    );
    return true;
  }
  if (cmd === "/game" && chatId < 0) {
    if (arg === "stop") {
      const msg = stopGame(chatId);
      await sender.sendDirect(chatId, msg ?? "没有进行中的游戏喵~", formatted.messageId);
      return true;
    }
    if (arg === "guess" || arg === "猜数字") {
      const game = createGuessNumberGame();
      const msg = startGame(chatId, game, undefined, (cid, text2) => sender.sendDirect(cid, text2));
      await sender.sendDirect(chatId, `${msg}\n本喵想了一个 1-100 的数字，来猜猜看~`, formatted.messageId);
      return true;
    }
    const { partyGame } = await import("../games/party.js");
    const party = partyGame(arg);
    if (party) { await sender.sendDirect(chatId, party, formatted.messageId); return true; }
    await sender.sendDirect(chatId, "可用游戏：/game guess（猜数字）· tod（真心话）· dare（大冒险）· wyr（二选一）· nhie（我从未）", formatted.messageId);
    return true;
  }

  // Collectible 猫娘 cards — /cards 图鉴 + /wish 换卡 (group only, no economy)
  if (chatId < 0 && (cmd === "/cards" || cmd === "/wish") && !formatted.isAnonymous) {
    const { handleGachaCommand } = await import("../gacha/commands.js");
    const reply = await handleGachaCommand(chatId, formatted.uid, cmd, arg);
    if (reply) { await sender.sendDirect(chatId, reply, formatted.messageId); return true; }
  }

  // /help — list all features
  if (cmd === "/help") {
    const { buildHelpText } = await import("../../bot/handlers/help.js");
    await sender.sendDirect(chatId, await buildHelpText(), formatted.messageId);
    return true;
  }

  // Core v2 Phase 5：/skill —— 主人 DM 专属，skill 门审批。
  // 非主人 / 非 DM 一律拒绝（不透露门存在，只说用不了）。
  //   /skill pending                    待审列表（verified 待批准 + proposed 待验证）
  //   /skill approve <lifecycleId>      人审批准（verified → approved）
  //   /skill publish <lifecycleId>      发布（approved → skills 表）
  //   /skill verify <lifecycleId>       手动触发 verify（proposed → verified/rejected）
  //   /skill reject <lifecycleId>       驳回（verified/proposed → rejected）
  //   /skill show <lifecycleId>         看候选内容
  if (cmd === "/skill") {
    const { handleSkillCommand } = await import("../../core/skills/commands.js");
    const reply = await handleSkillCommand(chatId, formatted.uid, arg.trim());
    if (reply) { await sender.sendDirect(chatId, reply, formatted.messageId); return true; }
  }

  return false;
}

/**
 * round 61（新 goal，用户："很难融入话题"）：**人在纠正/生气时硬止损。**
 *
 * 实测（2026-09-23，-1004430867819，0/18 没人接）：
 *   04:49-04:56 bot 连发 14 条，全是同一件事的变体。
 *   而群里的人已经在纠正它：
 *     @hunhebi_bot 再说一次，我的节点没有炸（生气）
 *     噗，人家又没说你节点炸。
 *
 * 人在纠正，它还在刷。而这个群 0% 有人接的真相是：刷的内容没人想接，
 * 人只在纠正它——"纠正"没被算进 replied/reacted，所以我量成了 0%。
 *
 * 这是**止损**，不是改心流判据（那是操作手册第 3 档、要拍板）。
 * 判据纯文本：冲着 bot 来（@ / 回复 bot / 叫名字）+ 带纠正或负面词。
 * 命中就静默 + 按群冷却 N 分钟。**不发任何解释性回复**——
 * 这时候任何回复都是加分。
 */
const CORRECTION_RE = /(?:别说了|够了|烦死|烦不烦|闭嘴|安静|再说一次|不是说了|讲过了?|重复|刷屏|好吵|停一下|打住|有完没完|生气|气死|恼火|无语|服了)/i;
const CORRECTION_COOLDOWN_SEC = 600;
const CORRECTION_KEY = (chatId: number): string => `xxb:corrected:${chatId}`;

export async function tryCorrectionIntercept(
  chatId: number,
  formatted: FormattedMessage,
  judgeOrOpts: JudgeResult | { addressedRule: string },
): Promise<boolean> {
  if (chatId >= 0) return false;                 // 群聊 only
  if (formatted.isBot || formatted.isAnonymous) return false;
  const text = (formatted.textContent || formatted.captionContent || '').trim();
  if (text.length < 2) return false;

  // 只认"冲着 bot 来"的——ADDRESSED_RULES 是既有判据。
  // 群友之间互呛不该让 bot 闭嘴。
  // ADDRESSED_RULES 已在文件顶部从 ../shared.js 导入。
  // 两种调用形态：legacy 传 JudgeResult（有 rule）；Meta 没有 judge，
  // 传 { addressedRule }（它只有 isDirect）。判据取 rule ?? addressedRule。
  // Meta 那边没有 judgeResult，用 opts.isDirect 合成：
  //   isDirect=true  → 'mention_self'（ADDRESSED_RULES 里最通用的"冲着 bot 来"）
  //   isDirect=false → '' （空串必不命中 = 不拦）
  // 不能塞 'direct'——它不在 ADDRESSED_RULES 里，拦不住任何东西。
  // 用 optional-chaining + 判别联合：JudgeResult.rule 是 `string | undefined`
  // （可缺省），而 Meta 那侧的 `addressedRule` 一定存在。
  // 直接 'rule' in x 判不出联合（JudgeResult 也可能带 undefined 的 rule）。
  const maybeRule = (judgeOrOpts as { rule?: string }).rule;
  const rule = maybeRule !== undefined
    ? maybeRule
    : ((judgeOrOpts as { addressedRule?: string }).addressedRule === 'direct' ? 'mention_self' : '');
  if (!ADDRESSED_RULES.has(rule)) return false;

  if (!CORRECTION_RE.test(text)) return false;

  try {
    await getRedis().set(CORRECTION_KEY(chatId), '1', 'EX', CORRECTION_COOLDOWN_SEC);
  } catch {
    return false;                                 // Redis 挂了不拦截
  }
  logger.info(
    { chatId, uid: formatted.uid, rule, text: text.slice(0, 60), cooldownSec: CORRECTION_COOLDOWN_SEC },
    'correction: 人在纠正/生气 → 群冷却',
  );
  incrCounter('correction_cooldown_total', { chat: chatId });
  await sender.sendDirect(chatId, '…知道了。本喵安静会儿。', formatted.messageId);
  return true;
}

/** round 61：这个群当前是不是处在"被纠正"冷却中。*/
export async function isCorrectionCooling(chatId: number): Promise<boolean> {
  try {
    return (await getRedis().get(CORRECTION_KEY(chatId))) === '1';
  } catch {
    return false;
  }
}
export async function tryPreMuteIntercepts(
  chatId: number,
  formatted: FormattedMessage,
  judgeResult: JudgeResult,
): Promise<boolean> {
  // DM: disable group-only commands (/checkin, /stats)
  if (chatId > 0 && judgeResult.rule === "whitelisted_command") {
    const cmd = (formatted.textContent || "").trim().split(/[\s@]/)[0]?.toLowerCase();
    if (cmd === "/checkin" || cmd === "/stats") {
      await sender.sendDirect(chatId, "签到和统计功能只在群里有效喵~", formatted.messageId);
      return true;
    }
  }

  // Slash commands → dispatch
  if (judgeResult.rule === "whitelisted_command" && !formatted.isAnonymous) {
    const text = (formatted.textContent || "").trim();
    const cmd = text.split(/[\s@]/)[0]?.toLowerCase() ?? "";
    const arg = text.replace(/^\/\w+(?:@\w+)?\s*/, "").trim();
    if (await dispatchCommand(chatId, formatted, cmd, arg)) return true;
  }

  // Natural-language command invocation. DM: any clear intent executes. Group:
  // only when the bot is addressed (mention / reply-to-bot), per the addressing rule.
  if (!formatted.isAnonymous && judgeResult.rule !== "whitelisted_command") {
    const addressed = chatId > 0 || ADDRESSED_RULES.has(judgeResult.rule ?? "");
    if (addressed) {
      const { detectCommandIntent } = await import("../nl-commands.js");
      const intent = detectCommandIntent(formatted.textContent || "");
      if (intent) {
        if (intent.kind === "llm") {
          // /checkin & /stats are group-only and rendered by the reply LLM.
          if (chatId > 0) {
            await sender.sendDirect(chatId, "签到和统计只在群里有效喵~", formatted.messageId);
            return true;
          }
          // Rewrite to the canonical slash so the reply-side data injection fires.
          formatted.textContent = intent.cmd;
        } else if (await dispatchCommand(chatId, formatted, intent.cmd, intent.arg)) {
          return true;
        }
      }
      // 「学习+调用 agent」的调用半:意图明确匹配某条 ready 已学命令 → 代发之(短路)。
      // 放在 nl-commands(自己的命令)之后:先处理自己的,再看要不要借力别的 bot。
      // 仅群聊 + 已寻址(addressed)时才走;默认关(BOT_COMMAND_ROUTER_ENABLED)。
      if (chatId < 0 && env().BOT_COMMAND_ROUTER_ENABLED && env().BOT_DELEGATION_ENABLED) {
        const { routeLearnedCommand } = await import("../command-router.js");
        if (await routeLearnedCommand(chatId, formatted)) return true;
      }
    }

    // ── 群主自助开关反广告（确定性路径，不经过模型）────────────────────
    //
    // 2026-09-21 round 135。用户实测：在 uzumaru 群说"开一下反广告"，
    // **什么都没发生**。日志追踪：
    //   message in → Meta dispatch.taskToGroup → CodeAct task start
    //   → agent: message routed to running long task as interrupt
    // 这条命令被当成 interrupt 吸进了一个正在跑的长任务里，而
    // `admin.setAntiAd` 全库只有一个调用方（subagent 的 host api），
    // 生产调用次数 **0**（round 125 清单）。
    //
    // 也就是说：一个会删消息、会禁言人的开关，只能靠模型自己决定调工具，
    // 而模型在有长任务时连这句话都接不到。
    //
    // 所以这里加确定性路径：认得出"开/关反广告"就直接办，
    // 校验发起者是本群管理员/群主（fail-closed），然后 setAntiAd。
    // 模型那条路留着——它更灵活（能带 minutes），但不再是唯一的一条。
    if (chatId < 0) {
      const { tryAntiAdCommand } = await import("./antiad-command.js");
      if (await tryAntiAdCommand(chatId, formatted)) return true;
    }
  }

  return false;
}

// ── Extracted helper 4: Post-mute-gate intercepts ───────────────────

export async function tryPostMuteIntercepts(
  chatId: number,
  formatted: FormattedMessage,
  judgeResult: JudgeResult,
): Promise<boolean> {
  // Sticker dislike interception
  if (judgeResult.rule === "sticker_dislike" && formatted.replyTo) {
    const sent = lookupSentSticker(chatId, formatted.replyTo.messageId);
    if (sent) {
      recordStickerDislike(sent.fileUniqueId, chatId, formatted.uid);
      const score = getStickerScore(sent.fileUniqueId);
      const ack = score <= 0.1
        ? "好的，这个贴纸不会再出现了喵~"
        : "知道了，下次少用这个贴纸~";
      await sender.sendDirect(chatId, ack, formatted.messageId);
      logger.info({ chatId, fileUniqueId: sent.fileUniqueId, newScore: score, userId: formatted.uid }, "Sticker dislike recorded");
      return true;
    }
  }

  // 记住/查看/忘掉偏好的关键词拦截已下线 —— remember/forget 改由 directive.ts
  // (回复前 LLM 指令分类)静默执行 + emoji ack。

  return false;
}
