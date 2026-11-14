/** Telegram chat provenance for digests; unknown or mixed sources are not public. */
export interface DigestReadScope {
  sourceChatId: number;
}

export function isDigestSourceChatId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value !== 0;
}

/** A single-chat label is valid only when every contributing source agrees. */
export function singleDigestSourceChatId(sources: readonly unknown[]): number | undefined {
  const first = sources[0];
  return isDigestSourceChatId(first) && sources.every((source) => source === first)
    ? first
    : undefined;
}

export function digestBelongsToChat(sourceChatId: unknown, requestedChatId: unknown): boolean {
  return isDigestSourceChatId(requestedChatId) && sourceChatId === requestedChatId;
}
