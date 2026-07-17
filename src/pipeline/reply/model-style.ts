// ────────────────────────────────────────
// Per-model 风格补丁 —— 不同基座性格不同,补一段针对性提示拉齐到目标风格
// ────────────────────────────────────────
//
// 现有 prompt 是照 grok 调的(天生又短又损、一句怼完)。换别的模型当 reply 时,
// 基座性格差异会跑偏:gemini 爱多给半句、多解释一层、爱铺垫,整体偏啰嗦。
// 这里按**实际用的 reply 模型**补一段专属风格提示,让它们也达到 grok 那个利落感。
//
// 按 model 名子串匹配(reply usage 的主 label 的 model);命中就注入到 reply prompt
// 靠近 CURRENT_MESSAGE 的位置(reply.ts)。grok 无补丁(它本来就对)。

const NUDGES: Array<{ match: RegExp; nudge: string }> = [
  {
    // Gemini 系:天生话多,尤其爱给同一个人拆出第二条"解释/补充"。狠狠压成一句怼死。
    // (实测:温和提醒无效,必须硬性"只出一条";A/B 后这版能把它拉到 grok 的利落感。)
    match: /gemini/i,
    nudge:
      '[你这个基座专属·硬性] 你的通病:回同一个人爱拆成好几条、爱加第二条"解释/补充/去测测看/其实/不过"。' +
      '**回同一个人时只出一条、一句话怼完就停**——不解释原因、不列方案、不铺垫、不加"估计/其实/不过/要不要"。' +
      '像 grok 那样一句损死(例:"300而已急啥 多半线路抽风 真被墙早超时了")。宁可少说,绝不啰嗦。' +
      '(注意:多个**不同的人**问了不同的事,仍照常分人各回一条——这条只管"别给同一个人啰嗦第二句"。)',
  },
  // 以后接别的模型再加,例如:
  // { match: /kimi|step/i, nudge: '...' },
];

/** 按 reply 实际用的 model 名,返回该模型专属的风格补丁(没有就 undefined)。 */
export function modelStyleNudge(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return NUDGES.find((n) => n.match.test(model))?.nudge;
}
