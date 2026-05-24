// ────────────────────────────────────────
// Token 计数 (tiktoken)
// ────────────────────────────────────────

import { get_encoding } from 'tiktoken';
import type { Tiktoken } from 'tiktoken';

let _enc: Tiktoken | undefined;

function getEncoder(): Tiktoken {
  if (!_enc) {
    _enc = get_encoding('o200k_base');
  }
  return _enc;
}

/** Count tokens for a single string */
export function countTokens(text: string): number {
  if (!text) return 0;
  return getEncoder().encode(text).length;
}

/** Count tokens for a chat message array */
export function countMessageTokens(
  messages: Array<{ role: string; content: string }>,
): number {
  let total = 0;
  for (const msg of messages) {
    // OpenAI cookbook formula for o200k_base (gpt-4o): +4 tokens per message
    // for role/separator overhead (<|im_start|>role\n…<|im_end|>\n).
    total += 4;
    total += countTokens(msg.content);
  }
  // +2 for the assistant turn priming tokens (<|im_start|>assistant\n)
  total += 2;
  return total;
}

/** Free the encoder (for cleanup) */
export function freeEncoder(): void {
  if (_enc) {
    _enc.free();
    _enc = undefined;
  }
}
