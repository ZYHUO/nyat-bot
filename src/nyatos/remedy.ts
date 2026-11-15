// ────────────────────────────────────────
// 反广告 · 可用手段（Remedy）
// ────────────────────────────────────────
//
// 立场与反广告同一条：**宿主只报"这个群现在能做什么"，模型决定做不做。**
//
// 为什么需要这一行
// ────────────────
// 在接上 `bots.command`（回复式代发）之前，Frame 只告诉模型"此人在刷屏"
// （[噪声] 行），却不告诉它**手上有牌**。于是出现最差的半开状态：bot 看见
// 广告号在刷屏，手上只有一张"装没看见"，或者反过来在没授权的群里乱出手。
//
// 这里只回答一个问题：**本群群主授过权吗？**
//   授过 → 报一行"可以怎么做"，并且只报**真的可用的**那几条
//   没授 → 什么都不报（这一行根本不出现，模型自然知道别动手）
//
// 两张牌（都由群主授权解锁，都不是自动执行）
// ─────────────────────────────────────
//   admin.kick(uid)                    把机器行为号请出群（不可逆，对方要自己加回来）
//   bots.command 回复 /spam@nmnmfunbot  让 nmBot 封禁该用户并向 nmBot 举报
//
// 第二张牌的来历（2026-09-21 实测）：nmbot 的入群验证消息带 5 个按钮
// （在 App 中验证 / 打开浏览器验证 / 通过 / 拒绝 / 拒绝并举报骚扰），封禁回执
// 带 2 个（解除封禁 / 举报骚扰）。**这些按钮 bot 点不了**——Telegram 的
// callback_query 只能由真人点击产生，没有 API 能合成一次点击。但 nmbot 同时
// 认命令，`/spam` 是 needs_reply=1、18 次观察、confidence 0.95、status=ready，
// 回复那条广告发出去，效果就等于有人按了「拒绝并举报骚扰」。
//
// 这里**不写关键词表、不判"这是不是广告"**。清单来自 bot_command_profiles
// （长期观察学出来的），不是宿主拍的黑名单。

import { listReplyInvocableCommands } from '../learners/bot-command-store.js';
import { antiAdEnabled } from './ad-pressure.js';

export interface RemedyReading {
  /** 本群群主是否授过反广告的权（与 admin.kick 同一把钥匙）。 */
  granted: boolean;
  /** 当前可用的"回复式代罚"命令（来自命令档案，非宿主硬编码）。 */
  replyCommands: Array<{ bot: string; command: string; useScenario: string }>;
}

/** 读本群可用手段。没授权 → granted=false，调用方应当整行不渲染。 */
export async function readRemedies(chatId: number): Promise<RemedyReading> {
  if (!(chatId < 0)) return { granted: false, replyCommands: [] };
  const granted = await antiAdEnabled(chatId).catch(() => false);
  if (!granted) return { granted: false, replyCommands: [] };
  return { granted: true, replyCommands: listReplyInvocableCommands() };
}

/** 供 Frame 呈现用的一句话（事实，不是裁决，也不是指令）。 */
export function renderRemedies(r: RemedyReading): string {
  if (!r.granted) return '';
  const parts = ['admin.kick(uid) 把号请出群（不可逆）'];
  for (const c of r.replyCommands) {
    const what = c.useScenario ? `（${c.useScenario}）` : '';
    parts.push(`bots.command 回复那条消息发 ${c.command}@${c.bot}${what}`);
  }
  return (
    `[授权] 本群群主已开反广告，你可用的手段：${parts.join('；')}。` +
    '管不管、用哪张牌，你按 [噪声] 的事实自己定——先想删消息+禁言是不是已经够了。'
  );
}
