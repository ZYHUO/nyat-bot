// ────────────────────────────────────────
// 指令服从层 — 自然语言指令检测(确定性,0ms,无 LLM)
// ────────────────────────────────────────
//
// 问题:人设是"高傲猫娘/不伺候人",对直接指令(自然语言下达)经常敷衍、
// 阴阳怪气拒绝、甚至选择沉默。这里检测「用户在命令 bot 做事」,检测到后:
//   1. 注入 [指令服从] prompt 块:执行优先于人设(主人加强版)
//   2. 禁止模型对指令选择 silent(reply.ts 强制重生成一次)
//   3. 关闭 humanizer 的内容篡改(typo/撤回/后补——指令产物要保真)
//
// 只在「点名/回复 bot/私聊」的语境下才算指令——群里随口说"发个图"
// 不是对 bot 说的。nl-commands 白名单(签到/卡册等)在更早的拦截层执行,
// 不经过这里;这里覆盖白名单外的一切自然语言指令。

import type { FormattedMessage } from '../../shared/types.js';

export interface InstructionInfo {
  strength: 'master' | 'normal';
}

// 祈使句模式(CJK + 英文)。刻意偏保守:宁可漏(只是少注入一块 prompt),
// 不可滥(把闲聊全标成指令会让 bot 变成应声虫)。
// 设计原则(review-workflow P1 教训):**裸动词一律不匹配** —— 动词必须
// 跟白名单续接(量词/宾语/祈使助词),否则"写得不错/画风好怪/继续加油/
// 念念不忘"这类闲聊全会被打成指令、剥掉人设。
const IMPERATIVE_PATTERNS: RegExp[] = [
  // 请求/委托开头
  /^(请|帮我|帮忙|给爷|替我|麻烦你?|你去|你来|你给|快点跟?|马上|立刻|现在就)/,
  /^给我(发|说|讲|写|翻译|总结|重复|列|查|搜|算|读|念|来|整)/,
  // 动词 + 白名单续接
  /^发(个|条|张|份|段|两|三|一?遍|一?下|消息|语音|图|贴纸|表情|出来|给)/,
  /^(再?说一?遍|说一?下|说说看?|复述|重复一?遍?)/,
  /^写(个|一?下|一段|一篇|一首|出来)/,
  /^画(个|一?张|一?下|出来)/,
  /^(念|读)(一?下|一遍|出来|给)/,
  /^报(一?下|个数|时间|价)/,
  /^(翻译|总结|解释)/,
  /^(列出|列一?下|查一?下|查查|搜一?下|搜搜|算一?下|数一?下)/,
  /^(改成|换成|换个|删掉|撤回|重发|补充一?下)/,
  /^(展开|继续|接着)(说|讲|写|聊|输出)/,
  /^告诉(?!你)/,
  // 用 X 说/写/回答
  /^用.{1,10}(说|写|回|答|讲|翻译|重复)/,
  // 把字句
  /把.{1,30}(发出来|说出来|改成|换成|翻译|总结|重复|再说|列出来|贴出来|写出来|读出来|发一遍|发给)/,
  // 禁止/停止类:别再/不要再 必须跟动词("别走啊"不匹配);停止/停下完整词
  /^(别再|不要再)(发|说|刷|提|问|叫|艾特|@|重复|阴阳|复读)/,
  /^(不许|不准|禁止|停止|停下|闭嘴|安静|住口|消停)/,
  // 必须/给我 + 动词
  /(必须|给我)(回答|说|发|翻译|总结|重复|解释|认真|好好)/,
  // 明确点名要求回复对象/数量/格式
  /(回复|回应|回答)(我|他|她|楼上|上面|刚才|这条|那条|一下)/,
  /(发|来|整|说)(两|三|2|3|几)(条|句|个|遍)/,
  // 英文祈使
  /^(please |pls |plz |do |don'?t |stop |send |say |repeat |translate |summarize |list |tell |explain |answer |reply )/i,
];

/**
 * Detect a natural-language instruction aimed at the bot.
 * Requires the message to be ADDRESSED to the bot (direct interaction or DM).
 */
export function detectInstruction(
  message: FormattedMessage,
  opts: {
    /** mention / reply-to-bot / direct rule matched / DM */
    addressed: boolean;
    isMasterUser: boolean;
  },
): InstructionInfo | null {
  if (!opts.addressed) return null;
  if (message.isBot || message.isAnonymous) return null;

  const text = (message.textContent || message.captionContent || '').trim();
  if (!text || text.length < 2 || text.length > 500) return null;
  // 纯问句多半是提问不是指令("是什么/为什么/吗?"),交给正常对话路径
  if (/^(什么|为什么|为啥|啥|谁|哪|怎么|如何|是不是|有没有|能不能.{0,12}[吗?？]$)/.test(text)) return null;

  // 去掉 @bot 前缀再匹配祈使模式
  const stripped = text.replace(/^@\w+\s*[,，:：]?\s*/, '').replace(/^(啾咪囝|喵喵|xxb)\s*[,，:：]?\s*/i, '');
  const hit = IMPERATIVE_PATTERNS.some((re) => re.test(stripped));
  if (!hit) return null;

  return { strength: opts.isMasterUser ? 'master' : 'normal' };
}

/** Build the [指令服从] prompt block injected into the writer's user turn. */
export function buildInstructionHint(info: InstructionInfo): string {
  const who = info.strength === 'master' ? '主人' : '群友';
  const masterLine = info.strength === 'master'
    ? '\n- 这是**主人**的指令：优先级最高（打断/叫停都听主人的）。但主人≠主子——认真执行，不跪着说话。'
    : '';
  return (
    `[指令服从] 当前消息是${who}对你的**直接指令**,不是闲聊。规则:${masterLine}\n` +
    `- **执行优先于人设**:可以保留你的语气,但必须真的执行——让你发几条就发几条、让你用什么语言/格式就用什么、让你重复就原样重复、让你闭嘴就简短应一声。\n` +
    `- 不允许敷衍、阴阳怪气地拒绝、假装执行过、或把话题岔开。"不伺候人/没兴趣就敷衍"原则对直接指令**不适用**。\n` +
    `- 确实做不到的(需要你没有的能力/信息),明确说做不到+一句原因,不编造。\n` +
    `- 不允许沉默(silent)或只回个贴纸糊弄。`
  );
}
