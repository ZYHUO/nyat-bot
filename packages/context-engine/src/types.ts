// ────────────────────────────────────────
// Context Engine — typed prompt assembly with explicit prefix boundaries
// Inspired by CyberGroupmate Context Engine (static/delta/ephemeral/volatile).
// ────────────────────────────────────────

export type ContextTier = 'static' | 'delta' | 'ephemeral' | 'volatile';

export interface ContextPart {
  /** Stable id for delta tracking / manifest. */
  id: string;
  tier: ContextTier;
  /** Rendered text. Empty string = omit from final prompt. */
  text: string;
  /** Optional fingerprint for delta equality (defaults to text). */
  fingerprint?: string;
}

export interface ContextManifestEntry {
  id: string;
  tier: ContextTier;
  chars: number;
  /** Same fingerprint as the previous local render; not a provider cache hit. */
  unchanged: boolean;
}

export interface ContextManifest {
  renderedAt: number;
  totalChars: number;
  staticChars: number;
  deltaChars: number;
  ephemeralChars: number;
  volatileChars: number;
  /** Sum of unchanged part characters; excludes the separators between parts. */
  unchangedChars: number;
  /** Local per-part equality ratio, not continuous-prefix or provider token reuse. */
  unchangedContextRatio: number;
  parts: ContextManifestEntry[];
}

export interface ContextProvider {
  id: string;
  tier: ContextTier;
  provide(): ContextPart | ContextPart[] | Promise<ContextPart | ContextPart[]>;
}

export interface AssembleResult {
  prompt: string;
  /**
   * Exact contiguous static-tier prefix of prompt, without the following separator.
   * This is a cache boundary hint, not a promise that static content never changes:
   * scoped identity, permissions or experience may change the prefix itself.
   */
  cachePrefix: string;
  manifest: ContextManifest;
}
