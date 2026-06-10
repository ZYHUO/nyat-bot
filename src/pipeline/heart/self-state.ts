// ────────────────────────────────────────
// 心流层 — 此刻的自我状态(叙述合成)
// ────────────────────────────────────────
//
// 之前的形态:[当前状态][今日状态][社交状态][最近执念][本群节奏] 五六个
// 独立标签块散在 prompt 里 —— 像一张体检表,不像一个"人此刻的样子"。
// 这里把 life-state / mood / focus / 孤独感 / 执念 合成**一段第一人称
// 叙述**,心流判断和写手共用同一份 —— 决定"接不接"的我和决定"怎么说"
// 的我是同一个我。
//
// 纯组装,无 LLM 调用;每个来源都 fail-soft。

import { getLifeState } from '../../tracking/life-state.js';
import { logger } from '../../shared/logger.js';

export interface SelfState {
  /** 第一人称叙述,2-5 句 */
  narration: string;
  /** 0..1(life-state energy × focus 融合,供调试/遥测) */
  energy: number;
}

export async function composeSelfState(chatId: number): Promise<SelfState> {
  const parts: string[] = [];
  let energy = 0.8;

  // 作息/精力(同步,确定性)
  try {
    const ls = getLifeState();
    energy = ls.energy;
    if (ls.state === 'sleeping') parts.push('现在是深夜,你困得不行,刚被消息吵醒,迷迷糊糊的');
    else if (ls.state === 'eating') parts.push('你正在吃饭,一边扒饭一边瞄手机');
    else if (ls.lazyDay) parts.push('今天你莫名蔫蔫的,什么都提不起劲,能少说就少说');
    else if (ls.hint?.includes('夜深')) parts.push('夜深了,你有点困但还赖着没睡');
    else if (ls.hint?.includes('刚睡醒')) parts.push('你刚睡醒没多久,还有点迷糊');
  } catch { /* fail-soft */ }

  // 群心情(mood,同步)
  try {
    const { getChatMood, moodPromptHint } = await import('../../tracking/mood.js');
    const hint = moodPromptHint(getChatMood(chatId));
    if (hint) {
      // moodPromptHint 已是自然语句,去掉可能的标签前缀
      parts.push(hint.replace(/^\[[^\]]*\]\s*/, ''));
    }
  } catch { /* fail-soft */ }

  // 对话热度(focus)
  try {
    const { getFocus } = await import('../turn/focus.js');
    const focus = await getFocus(chatId);
    if (focus > 0.65) parts.push('这个群你刚才说过几句话了(说太多就是刷屏,注意收着点)');
    else if (focus < 0.18) parts.push('这个群你最近没怎么看,半挂机状态');
    energy = energy * 0.6 + focus * 0.4;
  } catch { /* fail-soft */ }

  // 孤独感
  try {
    const { socialStateHint } = await import('../../tracking/social-needs.js');
    const social = await socialStateHint(chatId);
    if (social) parts.push(social);
  } catch { /* fail-soft */ }

  // 持续内心(L2):上一个念头/立场延续,不再每条消息失忆重启
  try {
    const { getMind } = await import('./mind.js');
    const mind = await getMind(chatId);
    if (mind.lastThought) parts.push(`你刚才心里想的是:「${mind.lastThought}」`);
    if (mind.stance) parts.push(`你最近一次发言的落点:「${mind.stance}」(别自相矛盾)`);
  } catch { /* fail-soft */ }

  // 本周执念
  try {
    const { getObsession } = await import('../../tracking/obsessions.js');
    const ob = await getObsession();
    // hint 是带标签的完整段,这里只要 flavor 短句
    const flavor = ob.hint.replace(/^\[[^\]]*\]\s*/, '').split('。')[0];
    if (flavor) parts.push(flavor);
  } catch { /* fail-soft */ }

  const narration = parts.length > 0
    ? parts.join('；') + '。'
    : '你状态正常,精神还不错。';

  logger.debug({ chatId, energy, parts: parts.length }, 'Self-state composed');
  return { narration, energy };
}
