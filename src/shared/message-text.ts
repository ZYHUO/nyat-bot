/**
 * Some upstream / LLM scaffolding wraps real user text as:
 *   用户Name{id: 123}发送了\n{真实内容}，考虑回复{ID392281}的对话。
 * That must never be treated as the user's actual words.
 */
export function unwrapPromptEnvelope(text: string): string {
  const t = String(text || '').trim();
  if (!t) return t;
  const m = t.match(
    /^用户[^\n{]*\{id:\s*\d+\}\s*发送了\s*[\n\r]*\{([\s\S]*?)\}\s*[，,]?\s*考虑回复/u,
  );
  if (m?.[1]?.trim()) return m[1].trim();
  return t;
}

export function looksLikePromptEnvelope(text: string): boolean {
  return /用户[^\n{]*\{id:\s*\d+\}\s*发送了/.test(String(text || '')) && /考虑回复/.test(String(text || ''));
}

/** Meta contentDirection must stay a short direction — never MaiBot envelopes / pasted scripts. */
export function sanitizeContentDirection(raw: string, quoteMessageId?: number): string {
  let s = String(raw || '').trim();
  if (!s) return quoteMessageId ? `短回 #${quoteMessageId}` : '短回';

  if (looksLikePromptEnvelope(s)) {
    const inner = unwrapPromptEnvelope(s).slice(0, 40);
    return quoteMessageId
      ? `短回 #${quoteMessageId}（对方说「${inner}」）。禁止复读自己上一句；只回这一句。`
      : `短回对方「${inner}」。禁止复读自己上一句。`;
  }

  // Strip accidental ID392281 / #id paste-only directions that don't say what to do
  s = s.replace(/考虑回复\{?ID?\s*\d+\}?的对话[。.]?/g, '').trim();
  if (s.length > 160) s = `${s.slice(0, 160)}…`;
  if (quoteMessageId && !s.includes(`#${quoteMessageId}`) && !s.includes(String(quoteMessageId))) {
    s = `短回 #${quoteMessageId}。${s}`;
  }
  if (!/禁止复读/.test(s)) s = `${s} 禁止复读自己上一句。`;
  return s;
}
