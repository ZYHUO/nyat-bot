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
