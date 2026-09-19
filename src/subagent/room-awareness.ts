// ────────────────────────────────────────
// 房间感知注入 — 让 CodeAct 任务 prompt 带上"这个房间里正在发生什么"
// ────────────────────────────────────────
//
// 为什么需要它（2026-09-19 真人对比分析）：
// 真人群友的消息**不是**对被引用消息的反应——
//   - 「插你的色屁股」「你一个机器人有个狗屁对讲机」——直白粗鲁
//   - 「就是一个ip对应一个v4或者v4+v6」「这种场景建议是分流走」——**主动贡献知识**，没人问
//   - 「后来隔了整整一天才看到消息」——**讲自己的事**，没人问
// 而 bot 的每一条发言都锚定在"上一条消息"上：它永远在**回应**，从不在**参与**。
// 这是"差一口气"的最大来源，不是措辞问题（bot 的短嘲其实已经很像人：
// "欠费艺术家"、"原生橘喵，血统自带喵"）。
//
// frame.ts 里其实**已经算好**了这些信号（谁在跟谁说话 / 未了话题 / 我的发言占比 /
// 我多久没说话），但它们只喂给 NyatOS shadow——而 shadow 在生产里只对 3 个群
// 开着（NYATOS_SHADOW_CHAT_IDS），**主回复路径一个字都用不到**。
// 这就是"模块存在但没接线"的又一例：造好了房间感知，驱动回复的 prompt 却看不到。
//
// 本模块只做一件事：把 frame 渲染进任务 prompt。不改变任何决策逻辑，
// fail-soft（读不到就不加），flag 默认关。

import { env } from '../env.js';
import { logger } from '../shared/logger.js';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** 句末带"喵"的比例与平均长度——喂给模型看的自我事实，不是配额也不是拦截。 */
function ownSpeechStats(botTexts: readonly string[]): string | null {
  const texts = botTexts.filter((t) => t.replace(/\s+/g, '').length >= 2).slice(-12);
  if (texts.length < 4) return null;
  const tail = texts.filter((t) => /喵[~。！？!?,，\s]*$/.test(t)).length;
  const avg = Math.round(texts.reduce((s, t) => s + t.replace(/\s+/g, '').length, 0) / texts.length);
  // 阈值 0.15：真人基准约 1%，所以只要明显高于常人就需要提醒。
  // 第一版用 0.4 是错的——实测各群 25%/33%/58%/58%，最活跃的群（6 小时 224 条）
  // 只有 33%，永远收不到提醒，而习惯正是在那里形成的。一行事实约 50 token，
  // 相对每天 580 万的量级可以忽略，没必要为省它而让模型看不见自己。
  // 曾经这里还会统计"光秃秃问号"的比例并提醒。**已撤**：阴性结果 + 前提被数据推翻。
  // 真人短反应也大量用秃问号（wyh？、呃？、？），所以"问句不带语气词"本身不是毛病；
  // 眞正的问题是**指控式问句**缺刹车片（「你搬的？」= 审讯，「你搬的嘛？」= 好奇）。
  // 那是条件判断，不是频率统计——留给 reply.md 的规则，不该由宿主按频率唠叨。
  if (tail / texts.length < 0.15) return null;
  return (
    `[你自已的毛病] 你最近 ${texts.length} 条消息里有 ${tail} 条拿"喵"收尾，` +
    `平均 ${avg} 字。群友里几乎没人这么说话——每句都喵，听起来像复读机，不像人。` +
    '这条你自己决定：语气到了就喵，没到就直接收。'
  );
}

export interface RoomAwarenessInput {
  chatId: number;
  botUid: number;
  /** 本次任务要回的那条消息 id（用于 triggerAge）与 forum 线程 */
  quoteMessageId?: number;
  messageThreadId?: number;
  /** bot 自己最近发过的消息（新的在前或旧的在前都行，内部排序），用于自我统计 */
  recentBotTexts?: readonly string[];
  /** 是否读"自己约自己的唤醒"（self_scheduled_wake 账本）。默认 false，理由同 withImpulses。 */
  withSelfWakes?: boolean;
}

export interface RoomAwareness {
  /** 渲染好的文本块；为空字符串表示没拿到可用信号 */
  text: string;
  /** 供日志/观测 */
  signals: string[];
}

/**
 * 渲染一段「你现在在这个房间里的处境」。fail-soft：任何一环读不到就少一段，
 * 全读不到返回空字符串（调用方直接跳过注入）。
 */
export async function renderRoomAwareness(input: RoomAwarenessInput): Promise<RoomAwareness> {
  if (!env().ROOM_AWARENESS_ENABLED) return { text: '', signals: [] };
  const signals: string[] = [];
  try {
    const { buildFrame, renderFrame } = await import('../nyatos/frame.js');
    const { getBotIdentity, getBotDisplayName } = await import('../bot/bot.js');
    const identity = getBotIdentity();

    const frame = await buildFrame({
      scope: { visibility: 'chat', chatId: input.chatId },
      trigger: {
        messageId: input.quoteMessageId ?? 0,
        role: 'user',
        uid: 0,
        username: '',
        fullName: '',
        timestamp: nowSec(),
        textContent: '',
        isForwarded: false,
        ...(input.messageThreadId !== undefined ? { messageThreadId: input.messageThreadId } : {}),
      },
      recent: [],
      botUid: input.botUid,
      botUsername: identity.username,
      botDisplayName: getBotDisplayName(),
      withImpulses: true,
      withSelfWakes: true,
    });
    const rendered = renderFrame(frame, { maxMessages: 8, maxChars: 1200 }).trim();
    if (!rendered) return { text: '', signals };

    if (frame.field) signals.push('field');
    if (frame.inner) signals.push('inner');
    // 身体事实：这些是 2026-09-19 之后新加的几段。signals 清单原本只报
    // field/inner/self_stats，于是"注入了 606 字"根本证明不了它们在里面——
    // 而我在Frame里已经错过三次"填了没渲染"，可观测性不能再缺同一环。
    if (frame.self.trench) signals.push('trench');
    if (frame.self.selfState) signals.push('self_state');
    if (frame.self.debt) signals.push('debt');
    if (frame.self.echo) signals.push('echo');
    if (frame.self.recentImpulses?.length) signals.push('impulses');

    // 自我统计：把自己的行为数据变成模型能看见的事实。
    // 2026-09-19：prompt 讲了三轮"别每句都喵"，模型只从 57% 降到 50%——因为全局比例
    // 是它在决策瞬间**看不见**的统计量，而它恰恰在情绪高点最想喵。写死规则去摘尾巴是
    // 规则引擎，违背"让 LLM 接管 harness"；给它看数字，让它自己掂量。
    // 自己取，别让调用方操心；调用方显式给了就用调用方的
    let ownTexts = input.recentBotTexts;
    if (!ownTexts) {
      try {
        const { getRecentBotTextsInChat } = await import('../tracking/self-history.js');
        ownTexts = getRecentBotTextsInChat(input.chatId, 12, 360);
      } catch (err) {
        logger.debug({ err, chatId: input.chatId }, 'room awareness: self-history unavailable');
      }
    }
    const own = ownSpeechStats(ownTexts ?? []);
    if (own) signals.push('self_stats');
    const lines: string[] = [];
    lines.push('[这个房间现在什么样]（以下是你的处境感知，不是要你汇报的内容）');
    lines.push(rendered);
    lines.push(
      '用法：真人不是只回"上一条"的——他们看圈子在聊什么、自己多久没说话、有没有人正在跟自己说话。' +
      '上面的信息是给你判断"现在该不该说、说给谁、说什么"用的，**不要**把这些字段名念出来。',
    );
    if (own) {
      lines.push('');
      lines.push(own);
    }
    // 自己的冲动史：单决策点这几条消息上想说什么。这是"它想参与"的直接证据，
    // 之前 1070 条判定写进账本后没有任何读者。给它看，它才知道自己想说话。
    const impulses = (frame.self.recentImpulses ?? []).slice(0, 4);
    if (impulses.length > 0) {
      const spoke = impulses.filter((i) => i.verdict === 'speak').length;
      lines.push('');
      lines.push(
        `[你刚才的念头] 最近 ${impulses.length} 条消息里，你有 ${spoke} 次是想接话的` +
          '（下面是她当时给自己的理由，不是要你复述）：',
      );
      for (const imp of impulses) {
        lines.push(`- ${imp.minutesAgo} 分钟前 ${imp.verdict}：${imp.why}`);
      }
      lines.push(
        '这些是你自己的念头，用它们判断"我现在还想不想说"，但**不要**把这段念白发给用户。',
      );
      signals.push(`impulses:${impulses.length}`);
    }

    // 自己约自己的事：到点了。这是 bot 唯一能"主动发起未来"的机制——
    // 不是 cron 定时，是它自己说"这事我过几分钟再想想"。
    // 默认可选退出（!== false）：这个渲染器的职责就是"把自我处境给模型看"，
    // 而 self_scheduled_wake 是其中唯一关于未来的部分。查询便宜（一次索引扫描）。
    if (input.withSelfWakes !== false) {
      try {
        const { listDueSelfWakes } = await import('../agent/cognitive-clock.js');
        const due = listDueSelfWakes({ visibility: 'chat', chatId: input.chatId }, Math.floor(Date.now() / 1000), 3);
        if (due.length > 0) {
          lines.push('');
          lines.push('[你约过自己的事]（这是你当时说"过会儿再想"的，现在到点了）：');
          for (const w of due) {
            lines.push(`- ${w.about ?? '（没写是什么）'}`);
          }
          lines.push(
            '想起来了就自然接一句，或者真的去做；已经不感兴趣了就让它过去，不用勉强。',
          );
          signals.push(`self_wakes:${due.length}`);
        }
      } catch (err) {
        logger.debug({ err, chatId: input.chatId }, 'room awareness: self wakes unavailable');
      }
    }
    if (frame.self.openThreads) signals.push('threads');
    if (frame.addressedToOthers) signals.push('addressed_to_others');
    return { text: lines.join('\n'), signals };
  } catch (err) {
    logger.debug({ err, chatId: input.chatId }, 'room awareness unavailable — skip injection');
    return { text: '', signals };
  }
}
