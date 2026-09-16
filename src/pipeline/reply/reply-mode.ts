import type { FormattedMessage, JudgeAction, ReplyPath } from '../../shared/types.js';

export type ReplyMode = 'micro_reaction' | 'ack_then_expand' | 'direct_answer' | 'task_progress' | 'silent';

export interface ReplyModeDecision {
  mode: ReplyMode;
  reason: string;
}

const UNCERTAINTY_RE = /(真的假的|真假的|真的吗|听说|据说|真的假的|不会吧|离谱到|真的假的啊)/u;
const TECHNICAL_RE = /(怎么|为什么|报错|错误|配置|代码|命令|接口|版本|部署|安装|修复|排查|解决|步骤|区别|原理|链接|地址|价格|查询|查一下|帮我)/u;
const QUESTION_RE = /[?？]|^(怎么|为什么|啥|什么|哪|谁|几|多少|是否|能不能|可以不可以)/u;

/**
 * Choose a writing shape from already-known routing/message facts. This is
 * deliberately deterministic so a style hint never costs another model call.
 */
export function resolveReplyMode(input: {
  message: FormattedMessage;
  action: JudgeAction;
  replyPath?: ReplyPath;
  instruction?: boolean;
  explicitDetailRequest?: boolean;
}): ReplyModeDecision {
  if (input.action !== 'REPLY') return { mode: 'silent', reason: 'not_reply' };
  if (input.instruction || input.explicitDetailRequest) {
    return { mode: 'direct_answer', reason: 'explicit_task_or_detail' };
  }

  const text = (input.message.textContent || input.message.captionContent || '').trim();
  if (!text) return { mode: 'micro_reaction', reason: 'empty_or_media_reaction' };
  if (UNCERTAINTY_RE.test(text) && text.length <= 80) {
    return { mode: 'ack_then_expand', reason: 'uncertain_interesting_claim' };
  }
  if (TECHNICAL_RE.test(text)) {
    return { mode: 'direct_answer', reason: 'question_or_technical_request' };
  }
  if (text.length <= 18 && !QUESTION_RE.test(text)) {
    return { mode: 'micro_reaction', reason: 'short_casual_message' };
  }
  if (input.replyPath === 'planned' || QUESTION_RE.test(text)) {
    return { mode: 'direct_answer', reason: 'planned_or_question' };
  }
  return { mode: 'micro_reaction', reason: 'casual_default' };
}

export function buildReplyModeHint(
  decision: ReplyModeDecision,
  isDM: boolean,
  options?: { ackThenExpandEnabled?: boolean; microReactionMaxChars?: number; ackMaxChars?: number },
): string {
  const microMax = options?.microReactionMaxChars ?? (isDM ? 20 : 12);
  const ackMax = options?.ackMaxChars ?? 12;
  if (decision.mode === 'silent') return '[回复形态] 当前不需要文字回复，若无必要请保持沉默。';
  if (decision.mode === 'micro_reaction') {
    return `[回复形态] mode=micro_reaction。当前是${isDM ? '私聊' : '群聊'}轻量接话，优先一条 2-${microMax} 字短反应；有话说就说完，不要为了显得有内容补解释或服务性尾巴。`;
  }
  if (decision.mode === 'ack_then_expand') {
    if (options?.ackThenExpandEnabled === false) {
      return '[回复形态] 当前不启用先接住再展开；用一条简洁、自然的回复直接表达判断或核实方向。';
    }
    return `[回复形态] mode=ack_then_expand。先用一条 2-${ackMax} 字短句接住惊讶/怀疑/情绪，再判断是否真的有必要补充；后续只写新信息，最多补一两句。首句必须有情绪或方向，不能只写「嗯」「在呢」「怎么啦」。`;
  }
  return '[回复形态] mode=direct_answer。认真问题或明确请求优先保证事实和必要步骤；第一句先给判断/结论，再补依据。不要用「这个问题比较复杂」「下面我将」之类 AI 式铺垫。短回复偏好不能删掉必要信息。';
}
