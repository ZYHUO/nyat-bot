export const QQ_MAX_TEXT_BUBBLES = 2;
export const QQ_MAX_BUBBLE_CHARS = 120;
const MAX_REPLY_CHARS = QQ_MAX_TEXT_BUBBLES * QQ_MAX_BUBBLE_CHARS;

export class QQTextPolicyError extends Error {
  readonly delivery = 'not_sent';
  constructor(readonly code: string, message: string) { super(message); }
}

/** No punctuation rewriting, removed asides, silent truncation or URL/code splitting. */
export function planQQTextBubbles(input: string): string[] {
  const text = input.trim();
  const size = (value: string) => [...value].length;
  const tooLong = () => new QQTextPolicyError('qq_text_too_long',
    '未发送：QQ 一次最多 2 个短气泡，每个不超过 120 字。请压缩完整回答，或用 telegram.sendTextFile 发送长内容；不要分多次绕过限额。');
  if (!text) throw new QQTextPolicyError('qq_text_empty', '未发送：正文为空。');
  if (size(text) > MAX_REPLY_CHARS) throw tooLong();
  const protectedSpans = [...text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`|https?:\/\/[^\s<>"']+/g)]
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
  const candidates: number[] = [];
  const explicitBreaks: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (!/[\n。！？!?；;]/u.test(text[i]!)) continue;
    if (protectedSpans.some(span => i >= span.start && i < span.end)) continue;
    if (i + 1 < text.length && /[。！？!?；;]/u.test(text[i + 1]!)) continue;
    const point = i + 1;
    const left = text.slice(0, point).trim(), right = text.slice(point).trim();
    if (left && right && size(left) <= QQ_MAX_BUBBLE_CHARS && size(right) <= QQ_MAX_BUBBLE_CHARS) {
      candidates.push(point);
      if (text[i] === '\n') explicitBreaks.push(point);
    }
  }
  if (size(text) <= QQ_MAX_BUBBLE_CHARS && !explicitBreaks.length) return [text];
  if (candidates.length) {
    // Prefer a complete natural boundary near the middle, never manufacture fragments.
    const boundaries = explicitBreaks.length ? explicitBreaks : candidates;
    boundaries.sort((a, b) => Math.abs(size(text.slice(0, a)) - size(text) / 2) - Math.abs(size(text.slice(0, b)) - size(text) / 2));
    const point = boundaries[0]!;
    return [text.slice(0, point).trim(), text.slice(point).trim()];
  }
  if (size(text) > QQ_MAX_BUBBLE_CHARS) throw tooLong();
  return [text];
}

/** Omission means an ordinary bubble; task anchors remain bookkeeping inputs. */
export function resolveQQReplyAnchor(raw: unknown, allowed: readonly number[]): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0 || !allowed.includes(raw)) {
    throw new QQTextPolicyError('qq_reply_anchor_invalid', '未发送：引用只能选择本任务提供的消息；不需要引用时省略 replyTo。');
  }
  return raw;
}

/** Reserve the entire reply before its first bubble, then charge confirmed receipts only. */
export function createQQBubbleBudget(limit: number) {
  let acknowledged = 0;
  let reserved = 0;
  return {
    reserve(count: number) {
      if (!Number.isSafeInteger(count) || count < 1 || acknowledged + reserved + count > limit) {
        throw new QQTextPolicyError('qq_text_budget', `sendText_limit:${limit}：剩余额度不足以完整发出这些气泡，请压缩成更少气泡；不要追加连发。`);
      }
      reserved += count;
      let pending = count;
      return {
        acknowledge() {
          if (!pending) throw new Error('qq_bubble_receipt_without_reservation');
          pending--; reserved--; acknowledged++;
        },
        release() { reserved -= pending; pending = 0; },
      };
    },
  };
}
