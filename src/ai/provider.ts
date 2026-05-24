// ────────────────────────────────────────
// AI Provider — Vercel AI SDK 统一调用层
// ────────────────────────────────────────

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { AILabel, AICallResult, ContentPart } from './types.js';
import { AIError } from '../shared/errors.js';
import { logger } from '../shared/logger.js';

// ── Claude native API (/v1/messages) ──────────────────────────────

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeResponse {
  content: Array<{ type: string; text: string }>;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  error?: { type: string; message: string };
}

async function callClaude(
  label: AILabel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: { maxTokens?: number; temperature?: number; timeout?: number },
): Promise<AICallResult> {
  const start = performance.now();
  const apiKey = label.apiKeys[0];
  if (!apiKey) throw new AIError('No API key configured', label.name, label.model, 'AI_NO_KEY');

  // Extract system prompt — wrap in array with cache_control to enable prompt caching
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMessages: ClaudeMessage[] = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

  const body: Record<string, unknown> = {
    model: label.model,
    messages: chatMessages,
    max_tokens: opts.maxTokens ?? 4096,
  };

  // Wrap system prompt as a content block with cache_control. The 5-layer
  // system prompt (persona + guardrails + schema + tone + task) is reused
  // across nearly every request, so ephemeral caching cuts that token
  // weight to ~10% of the regular cost on cache hits.
  if (systemMsg) {
    body['system'] = [
      {
        type: 'text',
        text: systemMsg.content,
        cache_control: { type: 'ephemeral' },
      },
    ];
  }

  if (opts.temperature !== undefined) body['temperature'] = opts.temperature;

  const res = await fetch(`${label.endpoint}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
  });

  const latencyMs = Math.round(performance.now() - start);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 429) {
      throw new AIError(`Rate limited: ${errText}`, label.name, label.model, 'AI_RATE_LIMIT');
    }
    // Detect content safety rejection
    if (errText.includes('high risk') || errText.includes('content_policy')) {
      throw new AIError(`Content rejected: ${errText}`, label.name, label.model, 'AI_CONTENT_REJECTED');
    }
    throw new AIError(`HTTP ${res.status}: ${errText}`, label.name, label.model);
  }

  const data = await res.json() as ClaudeResponse;
  if (data.error) {
    // Check for content safety errors in structured response
    if (data.error.type === 'invalid_request_error' &&
        (data.error.message.includes('high risk') || data.error.message.includes('content_policy'))) {
      throw new AIError(data.error.message, label.name, label.model, 'AI_CONTENT_REJECTED');
    }
    throw new AIError(data.error.message, label.name, label.model);
  }

  const rawText = data.content.filter(c => c.type === 'text').map(c => c.text).join('');
  const text = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();

  const usage = data.usage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  if (cacheRead > 0 || cacheWrite > 0) {
    logger.debug(
      { label: label.name, cacheRead, cacheWrite, fresh: usage.input_tokens },
      'Anthropic prompt cache stats',
    );
  }

  return {
    content: text,
    tokenUsage: {
      prompt: usage.input_tokens + cacheRead + cacheWrite,
      completion: usage.output_tokens,
      total: usage.input_tokens + cacheRead + cacheWrite + usage.output_tokens,
    },
    model: label.model,
    label: label.name,
    latencyMs,
  };
}

// ── OpenAI-compatible message serialization ───────────────────────

/** Check if any message contains image content parts */
function hasImageContent(messages: Array<{ content: string | ContentPart[] }>): boolean {
  return messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image'));
}

/** Convert internal ContentPart[] to OpenAI-compatible format */
function serializeContent(content: string | ContentPart[]): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  return content.map(p => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    return { type: 'image_url', image_url: { url: p.image } };
  });
}

// ── Raw OpenAI-compatible fetch (used for vision & stream) ────────

async function callOpenAIRaw(
  label: AILabel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>,
  opts: { maxTokens?: number; temperature?: number; timeout?: number; stream?: boolean },
): Promise<AICallResult> {
  const start = performance.now();
  const apiKey = label.apiKeys[0]!;
  const baseUrl = label.endpoint.replace(/\/+$/, '');
  // Append /chat/completions; add /v1 only if endpoint doesn't already end with a version path
  const chatUrl = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model: label.model,
    messages: messages.map(m => ({ role: m.role, content: serializeContent(m.content) })),
  };
  if (opts.maxTokens != null) body['max_tokens'] = opts.maxTokens;
  if (opts.temperature != null) body['temperature'] = opts.temperature;
  if (opts.stream) body['stream'] = true;
  if (label.reasoningEffort) body['reasoning_effort'] = label.reasoningEffort;
  if (label.disableThinking) body['thinking'] = { type: 'disabled' };

  const res = await fetch(chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 429) throw new AIError(`Rate limited: ${errText}`, label.name, label.model, 'AI_RATE_LIMIT');
    // Detect content safety rejection in OpenAI-compatible endpoints
    if (errText.includes('content_policy') || errText.includes('safety') || errText.includes('inappropriate')) {
      throw new AIError(`Content rejected: ${errText}`, label.name, label.model, 'AI_CONTENT_REJECTED');
    }
    throw new AIError(`HTTP ${res.status}: ${errText}`, label.name, label.model);
  }

  let fullText = '';

  if (opts.stream) {
    if (!res.body) throw new AIError('Stream body missing', label.name, label.model);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') break;
        try {
          const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          fullText += chunk.choices?.[0]?.delta?.content ?? '';
        } catch { /* ignore */ }
      }
    }
    buf += decoder.decode();
    if (buf.trim().startsWith('data:')) {
      const data = buf.trim().slice(5).trim();
      if (data !== '[DONE]') {
        try {
          const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
          fullText += chunk.choices?.[0]?.delta?.content ?? '';
        } catch { /* ignore */ }
      }
    }
  } else {
    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    fullText = json.choices?.[0]?.message?.content ?? '';
    const latencyMs = Math.round(performance.now() - start);
    const text = fullText
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .trim();
    return {
      content: text,
      tokenUsage: {
        prompt: json.usage?.prompt_tokens ?? 0,
        completion: json.usage?.completion_tokens ?? 0,
        total: json.usage?.total_tokens ?? 0,
      },
      model: label.model,
      label: label.name,
      latencyMs,
    };
  }

  const latencyMs = Math.round(performance.now() - start);
  const text = fullText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();

  if (!text) {
    throw new AIError('Empty response from stream', label.name, label.model, 'AI_EMPTY');
  }

  return {
    content: text,
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    model: label.model,
    label: label.name,
    latencyMs,
  };
}

// ── Main entry ────────────────────────────────────────────────────

export async function callModel(
  label: AILabel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>,
  opts: { maxTokens?: number; temperature?: number; timeout?: number } = {},
): Promise<AICallResult> {
  if (label.apiFormat === 'claude') {
    const textMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(p => p.type === 'text' ? p.text : '').join(''),
    }));
    try {
      return await callClaude(label, textMessages, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof AIError) throw err;
      if (message.includes('abort') || message.includes('timeout') || message.includes('TimeoutError')) {
        throw new AIError(`Timeout: ${message}`, label.name, label.model, 'AI_TIMEOUT');
      }
      throw new AIError(message, label.name, label.model);
    }
  }

  const start = performance.now();
  const apiKey = label.apiKeys[0];
  if (!apiKey) {
    throw new AIError('No API key configured', label.name, label.model, 'AI_NO_KEY');
  }

  // Use raw fetch for vision (image content) or stream-only endpoints
  // to ensure correct OpenAI-compatible image_url serialization
  if (hasImageContent(messages) || label.stream) {
    return callOpenAIRaw(label, messages, {
      ...opts,
      stream: label.stream,
    });
  }

  const provider = createOpenAI({
    baseURL: label.endpoint,
    apiKey,
    compatibility: 'compatible',
  });

  try {
    const result = await generateText({
      model: provider(label.model),
      messages: messages as Parameters<typeof generateText>[0]['messages'],
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      abortSignal: opts.timeout ? AbortSignal.timeout(opts.timeout) : undefined,
    });

    const latencyMs = Math.round(performance.now() - start);

    const rawText = result.text;
    const text = rawText
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .trim();

    return {
      content: text,
      tokenUsage: {
        prompt: result.usage?.promptTokens ?? 0,
        completion: result.usage?.completionTokens ?? 0,
        total: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
      },
      model: label.model,
      label: label.name,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);

    logger.warn({ label: label.name, model: label.model, latencyMs, err: message }, 'AI call failed');

    if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
      throw new AIError(`Rate limited: ${message}`, label.name, label.model, 'AI_RATE_LIMIT');
    }
    if (message.includes('abort') || message.includes('timeout') || message.includes('TimeoutError')) {
      throw new AIError(`Timeout after ${latencyMs}ms: ${message}`, label.name, label.model, 'AI_TIMEOUT');
    }
    if (message.includes('content_policy') || message.includes('safety') || message.includes('inappropriate')) {
      throw new AIError(`Content rejected: ${message}`, label.name, label.model, 'AI_CONTENT_REJECTED');
    }

    throw new AIError(message, label.name, label.model);
  }
}
