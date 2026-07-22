// ────────────────────────────────────────
// AI Provider — Vercel AI SDK 统一调用层
// ────────────────────────────────────────

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { Agent } from 'undici';
import type { AILabel, AICallResult, ContentPart } from './types.js';
import { AIError } from '../shared/errors.js';
import { mergeAbortSignals, isCallerAbort } from '../shared/abort.js';
import { logger } from '../shared/logger.js';

// 仅供**显式标记 insecureTLS 的供应商**(如自签证书的自建端点)使用的 dispatcher:
// 跳过证书校验。绝不设为全局 dispatcher —— 其它端点(Claude/StepFun 等)照常
// 全程验证证书。仅在 label.insecureTLS 为真时按 label 传入这个 dispatcher。
let _insecureDispatcher: Agent | undefined;
function insecureDispatcher(): Agent {
  if (!_insecureDispatcher) _insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  return _insecureDispatcher;
}

/** Throw a normalized AI_ABORTED error when the external signal fired (NOT for timeouts). */
function throwIfExternallyAborted(label: AILabel, signal?: AbortSignal): void {
  if (isCallerAbort(signal)) {
    throw new AIError('Aborted by caller', label.name, label.model, 'AI_ABORTED');
  }
}

function isContentSafetyRejection(message: string): boolean {
  return /content_policy|content[-_ ]?filter|safety|inappropriate|high risk|censorship_blocked|敏感内容|不安全/i.test(message)
    || /\b(?:content|output|outputted|machine outputted)\b[\s\S]{0,120}\bblocked\b/i.test(message);
}

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
  opts: { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal },
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
    signal: mergeAbortSignals(opts.timeout, opts.signal),
  });

  const latencyMs = Math.round(performance.now() - start);

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 429) {
      throw new AIError(`Rate limited: ${errText}`, label.name, label.model, 'AI_RATE_LIMIT');
    }
    // Detect content safety rejection
    if (isContentSafetyRejection(errText)) {
      throw new AIError(`Content rejected: ${errText}`, label.name, label.model, 'AI_CONTENT_REJECTED');
    }
    throw new AIError(`HTTP ${res.status}: ${errText}`, label.name, label.model);
  }

  const data = await res.json() as ClaudeResponse;
  if (data.error) {
    // Check for content safety errors in structured response
    if (data.error.type === 'invalid_request_error' && isContentSafetyRejection(data.error.message)) {
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
      cached: cacheRead,
    },
    model: label.model,
    label: label.name,
    latencyMs,
  };
}

// ── OpenAI-compatible message serialization ───────────────────────

/** Check if any message carries non-text media (image/audio) — forces the raw fetch path */
function hasMediaContent(messages: Array<{ content: string | ContentPart[] }>): boolean {
  return messages.some(
    m => Array.isArray(m.content) && m.content.some(p => p.type === 'image' || p.type === 'audio'),
  );
}

/** Convert internal ContentPart[] to OpenAI-compatible format */
function serializeContent(content: string | ContentPart[]): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  return content.map(p => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    if (p.type === 'audio') return { type: 'input_audio', input_audio: { data: p.audio, format: p.format } };
    // detail 默认 high:stepfun step-3.7-flash 识图必须带 detail=high(否则返回空);
    // OpenAI 系(sub2gpt54mini 等)也兼容 detail 字段,无副作用。
    return { type: 'image_url', image_url: { url: p.image, detail: p.detail ?? 'high' } };
  });
}

// ── Raw OpenAI-compatible fetch (used for vision & stream) ────────

async function callOpenAIRaw(
  label: AILabel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>,
  opts: { maxTokens?: number; temperature?: number; timeout?: number; stream?: boolean; signal?: AbortSignal; jsonMode?: boolean },
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
  // 强制合法 JSON(DeepSeek/OpenAI json_object)——根治单引号/Python-dict 之类的脏输出。
  // DeepSeek 要求 prompt 里出现 "json" 字样,否则硬报错 → 只在 prompt 含 json 时才开;
  // 顶层数组(多条回复)实测被允许,不影响多气泡。
  if (opts.jsonMode) {
    const hasJson = messages.some((m) =>
      typeof m.content === 'string'
        ? /json/i.test(m.content)
        : m.content.some((p) => p.type === 'text' && /json/i.test(p.text)),
    );
    if (hasJson) body['response_format'] = { type: 'json_object' };
  }

  const res = await fetch(chatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: mergeAbortSignals(opts.timeout, opts.signal),
    // 自签证书端点(insecureTLS)按 label 传 dispatcher 跳过校验;DOM fetch 类型
    // 无此字段,故 cast(与 src/pipeline/tools/search.ts 一致的写法)。
    ...(label.insecureTLS ? { dispatcher: insecureDispatcher() } : {}),
  } as RequestInit & { dispatcher?: Agent });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 429) throw new AIError(`Rate limited: ${errText}`, label.name, label.model, 'AI_RATE_LIMIT');
    // Detect content safety rejection in OpenAI-compatible endpoints
    if (res.status === 451 || isContentSafetyRejection(errText)) {
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
      choices?: Array<{
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
        };
      }>;
      usage?: {
        prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
        // DeepSeek-specific automatic prefix-cache accounting
        prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number;
        // OpenAI-style cached-token accounting
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const msg = json.choices?.[0]?.message;
    const rawContent = typeof msg?.content === 'string' ? msg.content : '';
    const rawReasoning = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : '';
    // Prefer visible content; only fall back to reasoning_content when content is empty
    // (some grok relays put the whole answer there).
    fullText = rawContent.trim() ? rawContent : rawReasoning;
    if (!rawContent.trim() && rawReasoning.trim()) {
      logger.info(
        { label: label.name, model: label.model, reasoningChars: rawReasoning.length },
        'AI empty content — using reasoning_content',
      );
    }
    const latencyMs = Math.round(performance.now() - start);
    // Prompt-cache visibility (DeepSeek auto prefix-cache / OpenAI cached_tokens).
    // Lets us confirm the stable-system-prefix design is actually paying off.
    const u = json.usage;
    const cacheHit = u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0;
    if (cacheHit > 0 || u?.prompt_cache_miss_tokens !== undefined) {
      const prompt = u?.prompt_tokens ?? 0;
      const cacheMiss = u?.prompt_cache_miss_tokens ?? Math.max(0, prompt - cacheHit);
      const hitRate = prompt ? +(cacheHit / prompt).toFixed(2) : 0;
      const payload = { label: label.name, cacheHit, cacheMiss, prompt, hitRate };
      // 高频观测默认走 debug；只有大 prompt 且命中率差时才升到 info，便于排查真正浪费。
      if (prompt >= 4000 && hitRate < 0.2) {
        logger.info(payload, 'prompt cache');
      } else {
        logger.debug(payload, 'prompt cache');
      }
    }
    const text = fullText
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .trim();
    if (!text) {
      throw new AIError('Empty response (no content/reasoning)', label.name, label.model, 'AI_EMPTY');
    }
    return {
      content: text,
      tokenUsage: {
        prompt: json.usage?.prompt_tokens ?? 0,
        completion: json.usage?.completion_tokens ?? 0,
        total: json.usage?.total_tokens ?? 0,
        cached: cacheHit,
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
  opts: { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal; jsonMode?: boolean } = {},
): Promise<AICallResult> {
  // MaiBot 借鉴:纯空白片段会让部分供应商返回 400/422(格式错)。
  // 文本消息空白 → 整条丢弃;内容数组里空白 text part → 滤掉该 part,
  // 滤空后只剩图片仍保留(vision 合法),全空才丢整条。
  messages = messages
    .map((m) => {
      if (typeof m.content === 'string') return m;
      const parts = m.content.filter((p) => p.type !== 'text' || p.text.trim().length > 0);
      return { ...m, content: parts };
    })
    .filter((m) => {
      const keep = typeof m.content === 'string' ? m.content.trim().length > 0 : m.content.length > 0;
      // 丢 system 消息绝不能静默:多半是 prompt 文件被写空(热重载读到
      // 半成品),人设全丢却查无此事比 400 更难排查。
      if (!keep && m.role === 'system') {
        logger.warn({ label: label.name }, 'Dropping EMPTY system message — prompt file blank?');
      }
      return keep;
    });

  if (label.apiFormat === 'claude') {
    const textMessages = messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(p => p.type === 'text' ? p.text : '').join(''),
    }));
    try {
      return await callClaude(label, textMessages, opts);
    } catch (err) {
      throwIfExternallyAborted(label, opts.signal);
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

  // Use raw fetch for vision (image content), stream-only endpoints, or
  // reasoning/thinking 控制(AI SDK generateText 不透传 reasoning_effort /
  // thinking —— 只有 raw 路径会把这些 body 字段发出去)。
  // insecureTLS 也强制走 raw 路径:AI SDK 的 createOpenAI 内部 fetch 无法注入
  // per-provider 的 undici dispatcher,只有 raw fetch 能挂上跳过校验的 dispatcher。
  if (hasMediaContent(messages) || label.stream || label.reasoningEffort || label.disableThinking || label.insecureTLS || label.forceRaw) {
    try {
      return await callOpenAIRaw(label, messages, {
        ...opts,
        stream: label.stream,
      });
    } catch (err) {
      throwIfExternallyAborted(label, opts.signal);
      throw err;
    }
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
      abortSignal: mergeAbortSignals(opts.timeout, opts.signal),
    });

    const latencyMs = Math.round(performance.now() - start);

    const rawText = result.text;
    const text = rawText
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .trim();

    if (!text) {
      throw new AIError('Empty response from SDK', label.name, label.model, 'AI_EMPTY');
    }

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

    throwIfExternallyAborted(label, opts.signal);

    logger.warn({ label: label.name, model: label.model, latencyMs, err: message }, 'AI call failed');

    if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
      throw new AIError(`Rate limited: ${message}`, label.name, label.model, 'AI_RATE_LIMIT');
    }
    if (message.includes('abort') || message.includes('timeout') || message.includes('TimeoutError')) {
      throw new AIError(`Timeout after ${latencyMs}ms: ${message}`, label.name, label.model, 'AI_TIMEOUT');
    }
    if (isContentSafetyRejection(message)) {
      throw new AIError(`Content rejected: ${message}`, label.name, label.model, 'AI_CONTENT_REJECTED');
    }

    throw new AIError(message, label.name, label.model);
  }
}
