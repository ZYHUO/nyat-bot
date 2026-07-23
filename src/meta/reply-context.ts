/**
 * Helpers for "user replied to message X while @bot" — Meta/CodeAct must
 * surface the parent bubble, not treat a bare @ as idle greeting.
 */

export interface ReplyToPayload {
  messageId: number;
  uid?: number;
  fullName?: string;
  textSnippet?: string;
}

/** True when the user bubble is effectively just a ping (@bot / empty / emoji). */
export function isBarePingText(text: string | undefined | null): boolean {
  const t = String(text ?? '')
    .replace(/\u200b/g, '')
    .trim();
  if (!t) return true;
  // @username / @botname only (optional trailing punctuation)
  if (/^[@＠][A-Za-z0-9_]{3,64}\s*[.。!！?？~～]*$/u.test(t)) return true;
  // very short non-substantive
  if (t.length <= 2) return true;
  return false;
}

/**
 * Short follow-ups that only make sense with the prior turn
 * (「快点告诉我」「为什么」「然后呢」). Not a bare @ping / not a new topic.
 */
export function isShortFollowUpText(text: string | undefined | null): boolean {
  const t = String(text ?? '')
    .replace(/\u200b/g, '')
    .trim();
  if (!t || isBarePingText(t)) return false;
  if (
    /^(快点|快说|快讲|告诉我|说嘛|说呀|为什么|为啥|然后呢|后来呢|接下来|继续|展开|详细说说|真的假的|是吗|是嘛|呢呢|嗯\?|嗯？)/.test(
      t,
    )
  ) {
    return t.length <= 36;
  }
  // ultra-short nudge without new content
  if (t.length <= 4 && /^(呢+|啊+|呀+|啦+|嘛+|哦+|嗯+|？|\?+)$/.test(t)) return true;
  return false;
}

export function replyToFromPayload(payload?: Record<string, unknown> | null): ReplyToPayload | null {
  const raw = payload?.['replyTo'];
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const messageId = Number(o['messageId']);
  if (!Number.isFinite(messageId) || messageId <= 0) return null;
  return {
    messageId: Math.floor(messageId),
    uid: typeof o['uid'] === 'number' ? o['uid'] : undefined,
    fullName: typeof o['fullName'] === 'string' ? o['fullName'] : undefined,
    textSnippet: typeof o['textSnippet'] === 'string' ? o['textSnippet'] : undefined,
  };
}

/** Compact replyTo suffix for Meta Attention lines. */
export function formatAttentionReplyToBit(payload?: Record<string, unknown> | null): string {
  const rt = replyToFromPayload(payload);
  if (!rt) return '';
  const snip = String(rt.textSnippet ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const who = rt.fullName ? ` ${rt.fullName}` : '';
  const snipBit = snip ? `「${snip}${snip.length >= 80 ? '…' : ''}」` : '';
  return ` replyTo=#${rt.messageId}${who}${snipBit}`;
}

/**
 * Drop Attention already claimed by diary/autoDispatch so Meta LLM cannot
 * re-script the same chat this session.
 */
export function filterAttentionForMetaLlm<T extends { chatId: number }>(
  attention: T[],
  dispatchedChatIds: Set<number>,
): T[] {
  if (dispatchedChatIds.size === 0) return attention;
  return attention.filter((a) => !dispatchedChatIds.has(a.chatId));
}

/** Build L0 contentDirection when the Attention item may carry replyTo. */
export function buildL0ContentDirection(opts: {
  who: string;
  messageId?: number;
  textPreview?: string;
  replyTo?: ReplyToPayload | null;
  /** Parent bubble is the bot's own prior message. */
  replyToIsSelf?: boolean;
  burstHint?: string;
  masterHint?: string;
}): string {
  const burst = opts.burstHint ?? '';
  const master = opts.masterHint ?? '';
  const tail = `${burst}${master}禁止复读用户原话；用本喵口吻接一句。`;
  const mid = opts.messageId ? `#${opts.messageId}` : '';
  const preview = String(opts.textPreview ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const previewBit = preview ? `「${preview}${preview.length >= 80 ? '…' : ''}」` : '';
  const rt = opts.replyTo;
  if (rt?.messageId) {
    const snip = String(rt.textSnippet ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    const whoRt = rt.fullName ? `${rt.fullName}` : '别人';
    const snipBit = snip ? `「${snip}${snip.length >= 180 ? '…' : ''}」` : '';
    if (opts.replyToIsSelf) {
      if (isBarePingText(opts.textPreview)) {
        return (
          `${opts.who} 用 reply+@ 点了你上一句 #${rt.messageId}${snipBit}。` +
          `针对那句短评/接话，禁止空问候（在呢/怎么啦/啥事）。` +
          `回气泡 quote 用户这条 ${mid || '消息'}。${tail}`
        );
      }
      return (
        `${opts.who} 在回复你的 #${rt.messageId}${snipBit} 的前提下发了 ${mid || '消息'}${previewBit}（内容见最近聊天）。` +
        `先弄清对方这一句和你上一句的关系再回；禁止臆造对方没提到的结论，禁止「没事/本喵看着」式糊弄。${tail}`
      );
    }
    if (isBarePingText(opts.textPreview)) {
      return (
        `${opts.who} 用 reply+@ 点了你：原消息是 ${whoRt} 的 #${rt.messageId}${snipBit}。` +
        `针对那条内容短评/接话（读懂论点再回），禁止空问候（在呢/怎么啦/啥事）。` +
        `回气泡 quote 用户这条 ${mid || '消息'}。${tail}`
      );
    }
    return (
      `${opts.who} 在回复 ${whoRt} 的 #${rt.messageId}${snipBit} 的前提下发了 ${mid || '消息'}${previewBit}（内容见最近聊天）。` +
      `回应要扣住被引用的那条，别当闲聊打招呼；禁止臆造未出现在最近聊天里的结论。${tail}`
    );
  }
  if (isShortFollowUpText(opts.textPreview)) {
    return (
      `${opts.who} 发了短接话 ${mid || ''}「${String(opts.textPreview).slice(0, 40)}」——` +
      `必须接上你/对方上一两句话题继续聊，禁止当新开场（在听/怎么啦/想听什么）。${tail}`
    );
  }
  if (opts.messageId) {
    return `短回 ${opts.who} 的消息 #${opts.messageId}（内容见最近聊天）。${tail}`;
  }
  return `短回 ${opts.who}（内容见最近聊天）。${tail}`;
}
