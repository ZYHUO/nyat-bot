// ────────────────────────────────────────
// Bot Message Classifier — 入站"其他 bot 消息"统一分类层(A/D/学习器共用地基)
// ────────────────────────────────────────
//
// 三家评审共识:多 bot 共存(A 互动)、广告降噪(D)、命令学习器都在处理
// 同一条入站 bot 消息。分头各判必冲突 → 这里给**唯一的**判定:这条 bot
// 消息是什么(botClass)+ 默认该怎么处理(suggestedBotAction)。
//
// 动作优先级(codex 定,消费者按此协作,**不在这里强制**):
//   receipt(代发回执,pipeline 3.96 先吃) > learn(命令学习) > interact(A 互动) > suppress(D 降噪) > ignore
//
// 纯函数 + 确定性正则,先 shadow(只打标不动作);精度够了再让 A/D 消费。

import type { FormattedMessage } from '../shared/types.js';

export type BotClass = 'self' | 'verify' | 'ad' | 'echo' | 'cmd_result' | 'chat' | 'unknown';
export type BotAction = 'receipt' | 'learn' | 'interact' | 'suppress' | 'ignore';

// 入群验证 / 验证机器人
const VERIFY_RE = /入群验证|完成验证|点击.{0,6}(加入|完成|验证)|验证(已)?(过期|失败)|已被永久封禁|请在\s*\d+\s*分钟内|complete.{0,3}verif|已通过.{0,2}验证/i;
// 机场/订阅广告:促销标记 + 价格/优惠信号同时命中才算(避免误伤群里正常聊机场/VPS)
const AD_PROMO_RE = /公益|优惠卡|机场|订阅|套餐|续费|加速|节点|流量|drainage|aff/i;
const AD_OFFER_RE = /最低.{0,4}(元|U|刀)|(\d+\s*(元|U|刀)).{0,3}(每月|\/月|每月)|每月.{0,4}\d|free|免费(领|送)|💎|🎁|优惠|促销|限时|首月/i;
// 已知职能 bot 用户名片段
const DOWNLOADER_RE = /(解析|download|music|parse|dl|聚合)/i;
const ECHO_BOT_RE = /(复读|echo|repeat|妙妙)/i;
// 已知"会话型"bot(对标:本喵想跟它们互动的同类),可随观察补充
const KNOWN_CHAT_BOTS = new Set<string>(['千雪', 'qianxue']);
// "X！X！X！" 复读句式:同一短段重复 ≥2 次
function looksLikeEcho(text: string): boolean {
  const segs = text.trim().split(/[！!]+/).map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return false;
  return segs.length >= 2 && new Set(segs).size === 1 && segs[0]!.length <= 10;
}

/**
 * 分类一条入站 bot 消息。cmdResultHint:该 bot 是否已有学到的命令档案
 * (有则倾向 cmd_result);调用方从 getProfilesForBot 传入,避免本模块依赖 DB。
 */
export function classifyBotMessage(
  m: FormattedMessage,
  opts?: { isSelf?: boolean; hasCommandProfile?: boolean },
): BotClass {
  if (opts?.isSelf || m.role === 'assistant') return 'self';
  if (!m.isBot) return 'unknown'; // 不该传非 bot,稳妥兜底
  const text = (m.textContent || m.captionContent || '').trim();
  const name = (m.username || m.fullName || '').toLowerCase();

  if (VERIFY_RE.test(text)) return 'verify';
  if (looksLikeEcho(text) || ECHO_BOT_RE.test(name)) return 'echo';
  if (AD_PROMO_RE.test(text) && AD_OFFER_RE.test(text)) return 'ad';
  // 命令回执:有学到的命令档案 / 是下载解析类 / 带 inline 按钮的结果态
  if (opts?.hasCommandProfile || DOWNLOADER_RE.test(name)) return 'cmd_result';
  // 会话型同类 bot(千雪)→ 互动候选
  if (KNOWN_CHAT_BOTS.has(name) || [...KNOWN_CHAT_BOTS].some((b) => name.includes(b))) return 'chat';
  if (m.fullName && [...KNOWN_CHAT_BOTS].some((b) => m.fullName.includes(b))) return 'chat';
  return 'unknown';
}

/** 该 botClass 的默认动作(消费者参考;receipt 由 pipeline 代发回执单独先判) */
export function suggestedBotAction(c: BotClass): BotAction {
  switch (c) {
    case 'verify': return 'ignore';
    case 'ad': return 'suppress';
    case 'echo': return 'suppress';
    case 'cmd_result': return 'learn';
    case 'chat': return 'interact';
    case 'self': return 'ignore';
    default: return 'learn'; // unknown:默认观察学习,别贸然降噪/互动
  }
}
