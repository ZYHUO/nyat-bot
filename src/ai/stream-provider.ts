// ────────────────────────────────────────
// AI Streaming Provider — Vercel AI SDK streamText
// ────────────────────────────────────────

import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { AILabel, ContentPart } from './types.js';
import { AIError } from '../shared/errors.js';
import { mergeAbortSignals } from '../shared/abort.js';
import { logger } from '../shared/logger.js';

export interface StreamResult {
  textStream: AsyncIterable<string>;
  /** Await this to get the full text after streaming completes */
  text: Promise<string>;
  /** Await this to get token usage after streaming completes */
  usage: Promise<{ promptTokens: number; completionTokens: number }>;
}

export function streamModel(
  label: AILabel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>,
  opts: { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal } = {},
): StreamResult {
  const apiKey = label.apiKeys[0];
  if (!apiKey) {
    throw new AIError('No API key configured', label.name, label.model, 'AI_NO_KEY');
  }

  const provider = createOpenAI({
    baseURL: label.endpoint,
    apiKey,
  });

  try {
    const result = streamText({
      model: provider(label.model),
      messages: messages as Parameters<typeof streamText>[0]['messages'],
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      abortSignal: mergeAbortSignals(opts.timeout, opts.signal),
    });

    return {
      textStream: result.textStream,
      text: result.text,
      usage: result.usage.then((u) => ({
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
      })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ label: label.name, model: label.model, err: message }, 'AI stream call failed');
    throw new AIError(message, label.name, label.model);
  }
}
