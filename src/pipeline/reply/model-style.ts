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

// 基座差异只补协议安全，不规定回复长度、段数或口头风格。
const NUDGES: Array<{ match: RegExp; nudge: string }> = [
  {
    match: /gemini|deepseek|v4-?(pro|flash)|dsv4/i,
    nudge:
      '[基座协议提醒] 只输出回复正文本身，不要带“回复给#XXXX”“回复:”或“@某人”等格式壳，也不要把消息编号/工具协议写进正文。回复长度和语气根据上下文自行判断。',
  },
];

/** 按实际模型补协议安全提醒；不干预自然交流判断。 */
export function modelStyleNudge(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return NUDGES.find((n) => n.match.test(model))?.nudge;
}
