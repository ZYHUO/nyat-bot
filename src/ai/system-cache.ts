export interface ClaudeSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** Preserve every system message and its bytes; a hint only chooses a boundary. */
export function buildClaudeSystem(
  systems: readonly string[], prefix?: string,
): { blocks: ClaudeSystemBlock[]; invalidPrefix: boolean } {
  const blocks: ClaudeSystemBlock[] = systems.map(text => ({ type: 'text', text }));
  const first = systems[0];
  if (prefix === undefined) {
    // Retain the previous default: cache the first complete system message.
    if (blocks[0]) blocks[0].cache_control = { type: 'ephemeral' };
    return { blocks, invalidPrefix: false };
  }
  const previousCode = first?.charCodeAt(prefix.length - 1) ?? 0;
  const nextCode = first?.charCodeAt(prefix.length) ?? 0;
  const splitsSurrogate = previousCode >= 0xd800 && previousCode <= 0xdbff
    && nextCode >= 0xdc00 && nextCode <= 0xdfff;
  if (!prefix.trim() || first === undefined || !first.startsWith(prefix) || splitsSurrogate) {
    // A stale or invalid hint cannot change the actual request or cache a
    // different string. Leave all text intact and omit the cache marker.
    return { blocks, invalidPrefix: true };
  }
  const stable: ClaudeSystemBlock = { type: 'text', text: prefix, cache_control: { type: 'ephemeral' } };
  const suffix = first.slice(prefix.length);
  return {
    blocks: [stable, ...(suffix ? [{ type: 'text' as const, text: suffix }] : []), ...blocks.slice(1)],
    invalidPrefix: false,
  };
}
