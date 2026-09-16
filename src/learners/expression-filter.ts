// ────────────────────────────────────────
// Expression filter — 附和句尾黑名单(共享:学习侧 + 注入侧)
// ────────────────────────────────────────
//
// 病根(主人吐槽"老是…是吧"):表达学习器把「…是吧」这类**附和/反问句尾
// 当标点**的口癖学成可复用句式,EXPRESSION_INJECT 每次注入又强化,形成
// 自激循环。MaiBot 的 reply_style 明文 ban 这类"固定化、模板化"结构。
//
// 这里把"附和句尾"做成确定性正则,同时挂在三处(cursor+qoder 一致结论):
//   - 学习侧 isLearnableExpression:不学进 DB
//   - 注入侧 getTopExpressions:即使 DB 残留也不注入(防历史残留 + merge 靠拢)
// prompt 软提醒挡不住 LLM 判断飘忽(线上 gate 批过 12 条是吧),代码硬挡。

// 句尾归一:剥掉尾部标点 / 猫腔「喵」/ 波浪号,再判是否以附和尾收口。
// 「全自动晦气机是吧」「…开团了是吧喵」「越南盲盒是吧」都被归一后命中。
const TAIL_STRIP = /[\s~～。.!！?？,，、…·]+$/g;
const AGREEMENT_TAIL =
  /(?:是吧|对吧|对不|是不|是嘛|是么|行吧|就[这那]吧|可不是嘛?|是不是吧)$/;

/** 这条 style 是不是"附和句尾当标点"的口癖(…是吧 / …对吧 / …行吧 等) */
export function isAgreementTail(style: string): boolean {
  if (!style) return false;
  let s = style.trim().replace(TAIL_STRIP, '');
  s = s.replace(/喵+$/, '').replace(TAIL_STRIP, '');
  // 赤裸模板「…是吧」也归一到 "是吧"
  s = s.replace(/^[…\.．]+/, '');
  return AGREEMENT_TAIL.test(s);
}

// 光是一个语气填充/附和词被当成"可复用句式"存下来 → 注入即复读(自激循环)。
// 「确实」「对对对」「属于是」「草」等本身是好词,问题在被学成模板反复注入。
const FILLER_ONLY =
  /^(?:确实|对+|嗯+|哦+|草|坏|乐|典|绷|蚌|红温|狠活|好家伙|嗝屁了?|属于是|绝了|离谱)$/;

// meta-规则:学习器误把"怎么说话"的说明当表达学了(如「本喵+动词,体现猫的身份」
// 「喵呜!开头,多用感叹号」),注入即把口癖当指令强化。真实表达不会自我描述。
const META_RULE = /体现|多用|开头[,，、]|[+＋]动词|的身份|口癖|口头禅|语气词/;

/**
 * 这条 style 该不该被 ban(既不学进 DB、也不注入)。合并三类自激口癖:
 *   1. 附和句尾(…是吧 / …对吧)—— isAgreementTail
 *   2. 「我勒个 X」句首口癖(当前失控的复读模板,含 meta「使用 我勒个xxx」)
 *   3. 光一个填充词的模板 + meta 说明句
 * prompt 软提醒挡不住 LLM 判断飘忽,和「是吧」一样上代码硬挡。
 */
export function isBannedExpression(style: string): boolean {
  if (!style) return false;
  if (isAgreementTail(style)) return true;
  if (/我勒个/.test(style)) return true;
  if (META_RULE.test(style)) return true;
  // 归一:剥「使用」壳 + 引号 + 只取首个短语 + 喵/标点,看核心是不是光一个填充词
  const core = style
    .trim()
    .replace(/^使用\s*/, '')
    .replace(/[「」"'`'']/g, '')
    .replace(/[，,。.!！?？~～、…·].*$/, '')
    .replace(/喵+$/, '')
    .replace(TAIL_STRIP, '')
    .trim();
  return FILLER_ONLY.test(core);
}
