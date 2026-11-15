import { inspectMetaChatScope } from './input-scope.js';

/** Chat provenance includes mapped QQ account identity; unknown/mixed is not public. */
export interface DigestReadScope {
  sourceChatId: number;
}

export function isDigestSourceChatId(value: unknown): value is number {
  return inspectMetaChatScope(value).status === 'valid';
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
