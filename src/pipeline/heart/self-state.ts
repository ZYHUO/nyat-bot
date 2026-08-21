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
// 纯组装,无 LLM 调用;每个来源都 fail-soft(debug 留痕,不再静默)。
// 审计 #38:四个独立异步源并行取(旧码 6 段串行 await,Redis RTT 串成
// 一列);同回合判断与写作共用一份快照(memo 在 turnContext 上,见
// pipeline.ts 心流分支),所以这里同时产出含/不含 lastThought 两个变体。

import { getLifeState } from '../../tracking/life-state.js';
import { logger } from '../../shared/logger.js';

export interface SelfState {
  /** 第一人称叙述,2-5 句(含「你刚才心里想的是…」,如有) */
  narration: string;
  /**
   * 同上但不含 lastThought 句。回复路径已把当下心流的 heartWhy 作为
   * [你的念头] 注入时用这份 —— 否则同一句话写两遍(review #14)。
   */
  narrationNoThought: string;
  /** 0..1(life-state energy × focus 融合,供调试/遥测) */
  energy: number;
}

export async function composeSelfState(chatId: number): Promise<SelfState> {
  // 四个独立异步源并行取;组装仍按固定顺序(life → mood → focus →
  // social → thought → stance → obsession),叙述与旧版逐字一致。
  const [moodPart, focusVal, socialPart, mindData, obsessionPart, schoolNarrative, weatherPart] = await Promise.all([
    (async (): Promise<string | null> => {
      try {
        const { getChatMood, moodPromptHint } = await import('../../tracking/mood.js');
        const hint = moodPromptHint(getChatMood(chatId));
        // moodPromptHint 已是自然语句,去掉可能的标签前缀
        return hint ? hint.replace(/^\[[^\]]*\]\s*/, '') : null;
      } catch (err) {
        logger.debug({ err, chatId }, 'self-state: mood source failed');
        return null;
      }
    })(),
    (async (): Promise<number | null> => {
      try {
        const { getFocus } = await import('../turn/focus.js');
        return await getFocus(chatId);
      } catch (err) {
        logger.debug({ err, chatId }, 'self-state: focus source failed');
        return null;
      }
    })(),
    (async (): Promise<string | null> => {
      try {
        const { socialStateHint } = await import('../../tracking/social-needs.js');
        return (await socialStateHint(chatId)) || null;
      } catch (err) {
        logger.debug({ err, chatId }, 'self-state: social source failed');
        return null;
      }
    })(),
    (async (): Promise<{ lastThought?: string; stance?: string } | null> => {
      try {
        const { getMind } = await import('./mind.js');
        return await getMind(chatId);
      } catch (err) {
        logger.debug({ err, chatId }, 'self-state: mind source failed');
        return null;
      }
    })(),
    (async (): Promise<string | null> => {
      try {
        const { getObsession } = await import('../../tracking/obsessions.js');
        const ob = await getObsession();
        // hint 是带标签的完整段,这里只要 flavor 短句
        const flavor = ob.hint.replace(/^\[[^\]]*\]\s*/, '').split('。')[0];
        return flavor || null;
      } catch (err) {
        logger.debug({ err, chatId }, 'self-state: obsession source failed');
        return null;
      }
    })(),
    // A3:今日感想(每日 cron 生成的一句碎碎念,Redis 缓存)
    (async (): Promise<string | null> => {
      try {
        const { env } = await import('../../env.js');
        if (!env().SCHOOL_SCHEDULE_ENABLED) return null;
        const { getRedis } = await import('../../db/redis.js');
        const { schoolNarrativeKey } = await import('../../cron/school-day-plan.js');
        const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
        return (await getRedis().get(schoolNarrativeKey(date))) || null;
      } catch (err) {
        logger.debug({ err, chatId }, 'self-state: school narrative source failed');
        return null;
      }
    })(),
    // 天气环境感知（真人感：一句话事实，fail-soft）
    (async (): Promise<string | null> => {
      try {
        const { getWeatherHint } = await import('../../shared/weather.js');
        return await getWeatherHint();
      } catch (err) {
        logger.debug({ err, chatId }, 'self-state: weather source failed');
        return null;
      }
    })(),
  ]);

  const before: string[] = [];
  let energy = 0.8;

  // 作息/精力(同步,确定性)
  let lifeSleeping = false;
  let lifeEating = false;
  try {
    const ls = getLifeState();
    energy = ls.energy;
    lifeSleeping = ls.state === 'sleeping';
    lifeEating = ls.state === 'eating';
    if (ls.state === 'sleeping') before.push('现在是深夜,你困得不行,刚被消息吵醒,迷迷糊糊的');
    else if (ls.state === 'eating') before.push('你正在吃饭,一边扒饭一边瞄手机');
    else if (ls.lazyDay) before.push('今天你莫名蔫蔫的,什么都提不起劲,能少说就少说');
    else if (ls.hint?.includes('夜深')) before.push('夜深了,你有点困但还赖着没睡');
    else if (ls.hint?.includes('刚睡醒')) before.push('你刚睡醒没多久,还有点迷糊');
  } catch (err) {
    logger.debug({ err, chatId }, 'self-state: life source failed');
  }

  // 上学日程(功能 A):睡眠硬门优先(睡着不注入);午饭由 life-state eating 覆盖,
  // 避免"在上课"和"在吃饭"打架。只调语气,行为延迟仍由 life-state 决定。
  if (!lifeSleeping && !lifeEating) {
    try {
      const { getSchoolSelfStateLine } = await import('../../tracking/school-state.js');
      const schoolLine = getSchoolSelfStateLine();
      if (schoolLine) before.push(schoolLine);
    } catch (err) {
      logger.debug({ err, chatId }, 'self-state: school source failed');
    }
  }

  // 天气(环境感知):睡着/吃饭时别违和地关心天气
  if (weatherPart && !lifeSleeping && !lifeEating) before.push(weatherPart);

  // 群心情(mood)
  if (moodPart) before.push(moodPart);

  // 对话热度(focus)
  if (focusVal !== null) {
    // 只给事实性在场感,不带"收着点"指令 —— 刷屏自检的规范表述在
    // heart.md,三处同时下达同一指令会把心流压成过度沉默(review #10)
    if (focusVal > 0.65) before.push('这个群你刚才说过几句话了');
    else if (focusVal < 0.18) before.push('这个群你最近没怎么看,半挂机状态');
    energy = energy * 0.6 + focusVal * 0.4;
  }

  // 孤独感
  if (socialPart) before.push(socialPart);

  // 持续内心(L2):上一个念头/立场延续,不再每条消息失忆重启
  const thoughtPart = mindData?.lastThought
    ? `你刚才心里想的是:「${mindData.lastThought}」`
    : null;
  const after: string[] = [];
  if (mindData?.stance) after.push(`你最近一次发言的落点:「${mindData.stance}」(别自相矛盾)`);

  // 本周执念
  if (obsessionPart) after.push(obsessionPart);

  // A3:今日感想(睡着时不提,免得跟"困得不行"打架)
  if (schoolNarrative && !lifeSleeping) after.push(`今天你心里念叨着:「${schoolNarrative}」`);

  const make = (withThought: boolean): string => {
    const all = [...before, ...(withThought && thoughtPart ? [thoughtPart] : []), ...after];
    return all.length > 0 ? all.join('；') + '。' : '你状态正常,精神还不错。';
  };

  const narration = make(true);
  const narrationNoThought = make(false);

  logger.debug(
    { chatId, energy, parts: before.length + after.length + (thoughtPart ? 1 : 0) },
    'Self-state composed',
  );
  return { narration, narrationNoThought, energy };
}
