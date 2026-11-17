/** SSE parsing only: no provider access, text logging, or inferred usage. */
export async function readOpenAIStream(body: ReadableStream<Uint8Array>): Promise<{
  text: string; usage: unknown;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let dataLines: string[] = [];
  let text = '';
  let usage: unknown;
  let done = false;

  const dispatch = (onlyComplete = false) => {
    if (!dataLines.length || done) return;
    const data = dataLines.join('\n');
    if (data.trim() === '[DONE]') { dataLines = []; done = true; return; }
    let value: unknown;
    try { value = JSON.parse(data); } catch {
      if (!onlyComplete) dataLines = [];
      return;
    }
    dataLines = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const chunk = value as { choices?: unknown; usage?: unknown };
    if (Array.isArray(chunk.choices)) {
      const first = chunk.choices[0] as { delta?: { content?: unknown } } | undefined;
      if (typeof first?.delta?.content === 'string') text += first.delta.content;
    }
    // Usage snapshots are cumulative; never sum repeated streaming frames.
    // Null on ordinary chunks does not erase an already reported snapshot.
    if (chunk.usage && typeof chunk.usage === 'object' && !Array.isArray(chunk.usage)) usage = chunk.usage;
  };
  const line = (raw: string) => {
    const value = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!value) { dispatch(); return; }
    if (value.startsWith('data:')) {
      // Some compatible relays omit SSE blank separators. Dispatch a complete
      // previous JSON value while retaining partial multi-line SSE JSON.
      dispatch(true);
      if (done) return;
      const field = value.slice(5);
      dataLines.push(field.startsWith(' ') ? field.slice(1) : field);
    }
  };
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while (!done && (newline = buffered.indexOf('\n')) >= 0) {
        line(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    }
    if (!done) {
      buffered += decoder.decode();
      if (buffered) line(buffered);
      dispatch();
    } else {
      // A cleanup rejection after [DONE] does not invalidate the completed body.
      await reader.cancel().catch(() => {});
    }
    return { text, usage };
  } finally {
    reader.releaseLock();
  }
}

/** Requesting optional usage must not break unverified compatible endpoints. */
export function supportsOpenAIStreamUsage(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && url.hostname === 'api.openai.com'
      && (!url.port || url.port === '443') && !url.username && !url.password;
  } catch { return false; }
}
