// ────────────────────────────────────────
// AI Provider — Vercel AI SDK 统一调用层
// ────────────────────────────────────────

import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { Agent } from 'undici';
import type { AILabel, AICallResult, ContentPart } from './types.js';
import { AIError } from '../shared/errors.js';
import { acquireConcurrency, AI_MAX_CONCURRENCY_PER_ACCOUNT } from './concurrency.js';
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
  /** 'end_turn' | 'max_tokens' | … —— 空正文时区分"截断"和"模型没话说"就靠它。 */
  stop_reason?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  error?: { type: string; message: string };
}

/**
 * reasoning 模型的 max_tokens 下限。
 *
 * 2026-09-21 加。起因是一次读数：`claude: 空正文` 诊断上线后 50 分钟内出现 193 次，
 * 全部是 `label: stepfun` + `stop_reason: max_tokens` + `blocks: ['thinking']`，
 * 而 maxTokens 的值是 **24 / 48 / 1200 / 4000 / 800 / 400 / 120 / 60**。
 *
 * 24 是哪来的：`src/cron/topic-scan.ts` 让模型"用 4-12 个汉字给当前主话题起个短标签"，
 * 于是写了 `maxTokens: 24`。听上去很合理——输出就那么点长。但 step-3.7-flash 是
 * reasoning 模型，思维链先烧 token：24 个 token 连一句"让我想想"都不够，
 * content 自然是空的。topic-scan 因此**静默地什么都没产出**，每 4 分钟 × 21 个群。
 *
 * 上一轮加的"截断就翻倍重试"在这里也不够：24 → 48 还是不够（诊断里 48 出现 73 次）。
 *
 * 所以改成**下限**而不是倍数：已知会截断的 label，max_tokens 一律抬到这个下限。
 * 1200 是实测值——step-3.7-flash 在短 prompt 上 reasoning + 正文合计约 840 token。
 *
 * 进程内记忆（不落盘）：重启后第一次截断会重新教会它，而截断本身就会打 warn，
 * 所以"学不会"是不可能的。不落盘是为了不给每条 LLM 调用加一次 Redis 读。
 */
const REASONING_TOKEN_FLOOR = 1200;


/** 观测到过"思维链吃光额度"的 label —— 之后给它下限而不是调用方写的小值。 */
const truncatingLabels = new Set<string>();

/** 测试用：清空记忆。 */
export function __resetTruncatingLabelsForTest(): void {
  truncatingLabels.clear();
}

/**
 * 这个 label 是不是 reasoning 模型（思维链计入 completion）。
 *
 * 为什么要一个判断而不只靠"观测到截断"：下限原本是**反应式**的——撞了才学。
 * 但 round 12 把 topic-scan 的 24 修掉之后，**唯一在触发的那个也不触发了**，
 * 下限随之失效，于是 post-task 的 `maxTokens: 200` 又开始被吃光
 * （24h 内 1480 次 `Empty response`）。
 * 反应式下限的问题是：它依赖"有别人在撞"，而别人都被修好那天它就瞎了。
 *
 * StepFun 全系（step-3.5/3.7-flash、step-5-preview）都是 reasoning，
 * 而 judge/summarize/reflection 的默认 label 正是它们。按模型名认，
 * 不硬编码 label 名单——label 会增删，模型名不会。
 */
function isReasoningModel(label: AILabel): boolean {
  return /^step-/i.test(label.model);
}

async function callClaude(
  label: AILabel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal; jsonMode?: boolean },
): Promise<AICallResult> {
  const asked = opts.maxTokens ?? 4096;
  // reasoning 模型一律托底下限：**不是**只对撞过的。
  // 上面 isReasoningModel 的注释解释了为什么反应式不够。
  const needsFloor = isReasoningModel(label) || truncatingLabels.has(label.name);
  const budget = needsFloor ? Math.max(asked, REASONING_TOKEN_FLOOR) : asked;
  const first = await callClaudeOnce(label, messages, { ...opts, maxTokens: budget });

  // 截断重试：`stop_reason === 'max_tokens'` 且正文为空 = 思维链把额度吃光，
  // 模型还没轮到输出就结束了。这在 StepFun reasoning 模型上是**最高频的失败模式**——
  // 日志里 `Empty response` 2882 次（stepfunthink 1481 / stepfunvision 685 /
  // stepfun 583 / stepfunjudge 133），是心流 "All labels exhausted"（占心流失败
  // 64%）的主要来源。旧行为把它当普通空响应交给 fallback 链，而 fallback 往往是
  // 同一个账号的另一个 label，撞的是同一个限额，于是一次性全灭。
  //
  // 只在这一种形状下重试（截断且空），加一倍额度、最多一次。别的情况不重试——
  // 内容审查/超时/限流重试没有意义，只会把延迟翻倍。
  if (first.truncated) {
    // 记住这个 label 会截断——之后它的每次调用都直接拿下限，不再先撞一次。
    const firstTime = !truncatingLabels.has(label.name);
    truncatingLabels.add(label.name);
    // 重试额度用**下限**而不是 2×：调用方写 24 时 2× 只有 48，照样不够
    // （诊断里 48 出现 73 次，就是重试也失败了）。下限是实测够用的值。
    const retryBudget = Math.min(Math.max(budget * 2, REASONING_TOKEN_FLOOR), 32_000);
    // 每个 label 只 info 一次：第一次截断是"这个模型想多了，我记下了"，
    // 值得看见；之后每次截断都 info 就是刷屏（实测 50 分钟 193 次）。
    // 后续的走 debug，靠上面的空正文 warn 诊断兜底。
    const log = firstTime ? logger.info : logger.debug;
    log(
      { label: label.name, model: label.model, budget, retryBudget, floor: REASONING_TOKEN_FLOOR, firstTime },
      'claude: 思维链吃光额度导致空正文 → 抬到下限重试一次',
    );
    try {
      const second = await callClaudeOnce(label, messages, { ...opts, maxTokens: retryBudget });
      if (!second.truncated) return second.result;
    } catch {
      // 重试失败就交回第一次的错误形状，别吞。
      // 只区分"调用方打断"（要上抛给 actor 重规划）和"重试也挂了"（用第一次的结果）。
      throwIfExternallyAborted(label, opts.signal);
    }
  }
  return first.result;
}

/** callClaude 的一次尝试。`truncated` = stop_reason 是 max_tokens 且正文为空。 */
async function callClaudeOnce(
  label: AILabel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  opts: { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal; jsonMode?: boolean },
): Promise<{ result: AICallResult; truncated: boolean }> {
  const start = performance.now();
  const apiKey = label.apiKeys[0];
  if (!apiKey) throw new AIError('No API key configured', label.name, label.model, 'AI_NO_KEY');

  // Extract system prompt — wrap in array with cache_control to enable prompt caching
  const systemMsg = messages.find(m => m.role === 'system');
  let chatMessages: ClaudeMessage[] = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

  // ── jsonMode：Anthropic 没有 response_format，用 assistant 预填实现 ──────
  //
  // 2026-09-21 加。起因是一次读数：`dreaming output unparseable — skipped`
  // **805 次，而 `dreaming consolidated` 一次都没出现过**（0% 产出）；
  // `distill output unparseable` 473 次 vs `episode distilled` 73 次（13.4%）。
  //
  // 病因：这两个 usage（judge / summarize）默认 `jsonMode: true`，而它们的 label
  // 是 `stepfun`，`FORMAT=claude`。**`jsonMode` 此前只对裸 fetch 的 OpenAI 路径
  // 生效**（那里设 `response_format`）；claude 分支根本不看这个参数——于是模型
  // 收到一个"请输出 JSON"的 prompt，却没有任何机制逼它，回中文散文，
  // 解析器 `JSON.parse` 失败，整次调用被丢弃。
  //
  // 这和 round 3 修的 ASI 假度量是同一个病根（那次靠换一个 OpenAI 格式的 label
  // 绕开）；这次在 provider 层修，所有 claude 格式 label 的 jsonMode 调用一起受益。
  //
  // 做法是 Anthropic 官方推荐的 prefill：末尾追加一条 assistant 消息，内容只有
  // "{"。模型只能接着这个括号往下写，输出必然是 JSON 的剩余部分。
  // 拿回来的正文要**把 "{" 拼回去**，否则调用方拿到的是 "{...}" 少了头。
  let jsonPrefill = false;
  if (opts.jsonMode && chatMessages.length > 0 && chatMessages[chatMessages.length - 1]!.role === 'user') {
    chatMessages = [...chatMessages, { role: 'assistant', content: '{' }];
    jsonPrefill = true;
  }

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

  const claudeTemp = label.temperature ?? opts.temperature;
  if (claudeTemp !== undefined) body['temperature'] = claudeTemp;

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
    const errText = sanitizeErrText(await res.text().catch(() => ''));
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

  // StepFun reasoning 模型可能只返回 thinking block 不带 text block，
  // 此时 rawText 为空 → "Empty response"。不把 thinking 当正文发出去，
  // 宁可报空让 fallback 链处理。
  const rawText = data.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('');
  const text = rawText
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
  // 预填的 "{" 要拼回去——调用方的解析器期待一个完整 JSON 对象。
  const finalText = jsonPrefill && text && !text.startsWith('{') ? `{${text}` : text;

  // 空正文时把**为什么空**记下来。此前这里只有一个结论性的注释，没有任何观测——
  // 2882 次 Empty response 到底是"思维链吃光额度"还是"模型真的不回话"，
  // 从日志里看不出来。现在能看出来，下一次就不用猜。
  const usage = data.usage;
  if (!finalText) {
    logger.warn(
      {
        label: label.name,
        model: label.model,
        stopReason: data.stop_reason,
        blocks: data.content.map((c) => c.type),
        outputTokens: usage.output_tokens,
        maxTokens: body['max_tokens'],
      },
      data.stop_reason === 'max_tokens'
        ? 'claude: 空正文 —— 思维链吃光 max_tokens（截断）'
        : 'claude: 空正文 —— 模型未产出 text block',
    );
  }
  const truncated = !finalText && data.stop_reason === 'max_tokens';

  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  if (cacheRead > 0 || cacheWrite > 0) {
    logger.debug(
      { label: label.name, cacheRead, cacheWrite, fresh: usage.input_tokens },
      'Anthropic prompt cache stats',
    );
  }

  return {
    result: {
      content: finalText,
      tokenUsage: {
        prompt: usage.input_tokens + cacheRead + cacheWrite,
        completion: usage.output_tokens,
        total: usage.input_tokens + cacheRead + cacheWrite + usage.output_tokens,
        cached: cacheRead,
      },
      model: label.model,
      label: label.name,
      latencyMs,
    },
    truncated,
  };
}

// ── OpenAI-compatible message serialization ───────────────────────

/** Check if any message carries non-text media (image/audio) — forces the raw fetch path */
function hasMediaContent(messages: Array<{ content: string | ContentPart[] }>): boolean {
  return messages.some(
    m =>
      Array.isArray(m.content) &&
      m.content.some(p => p.type === 'image' || p.type === 'audio' || p.type === 'video_url'),
  );
}

/** Convert internal ContentPart[] to OpenAI-compatible format */
function serializeContent(content: string | ContentPart[]): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  return content.map(p => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    if (p.type === 'audio') return { type: 'input_audio', input_audio: { data: p.audio, format: p.format } };
    // 视频：OpenAI 兼容口的 video_url part（2026-09-21，step-5-preview 实测可用）。
    if (p.type === 'video_url') return { type: 'video_url', video_url: { url: p.video_url.url } };
    // 图片必须是**最后一条显式分支**，不是兜底。
    //
    // 2026-09-21 改。旧写法把 image 当成 `return` 兜底：任何没被前面分支命中的
    // part 都会变成 `{type:'image_url', image_url:{url: undefined}}`。本会话已经
    // 吃过一次这个形状的亏——claude 分支把图片/音频/视频一律映射成空字符串，
    // 模型只收到文字，于是回"我没看到图片呀"，而 prompt token 数还对得上。
    //
    // 兜底的问题是**静默**：现在四种 part 都显式处理，看起来没问题；但只要有人
    // 给 ContentPart 加第五种（比如 document / sticker），它就会静默降级成
    // image_url 且 url 是 undefined，上游报一个看不懂的 400，或者更糟——当成
    // 空内容发出去。所以这里用 `never` 收口：加新 part 而没改这个函数，
    // **typecheck 直接红**，逼你到这里来做决定，而不是留到线上。
    if (p.type === 'image') {
      // detail 默认 high:stepfun step-3.7-flash 识图必须带 detail=high(否则返回空);
      // OpenAI 系(sub2gpt54mini 等)也兼容 detail 字段,无副作用。
      return { type: 'image_url', image_url: { url: p.image, detail: p.detail ?? 'high' } };
    }
    // 穷尽性检查：p 在此处应是 never。若 ContentPart 新增类型而此处未分支，
    // 这行会因 `Type 'X' is not assignable to type 'never'` 而编译失败。
    const _exhaustive: never = p;
    throw new Error(`serializeContent: 未处理的 content part 类型 ${JSON.stringify(_exhaustive)}`);
  });
}

// ── Raw OpenAI-compatible fetch (used for vision & stream) ────────


/** 上游错误体进日志前截断+脱敏(防自建中转 401 回显 key) — P1 fix 2026-08-22 */
function sanitizeErrText(raw: string): string {
  return raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .slice(0, 300);
}

async function callOpenAIRaw(
  label: AILabel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>,
  opts: { maxTokens?: number; temperature?: number; timeout?: number; stream?: boolean; signal?: AbortSignal; jsonMode?: boolean },
): Promise<AICallResult> {
  const start = performance.now();
  const apiKey = label.apiKeys[0];
  if (!apiKey) throw new AIError('No API key configured', label.name, label.model, 'AI_NO_KEY');
  const baseUrl = label.endpoint.replace(/\/+$/, '');
  // Append /chat/completions; add /v1 only if endpoint doesn't already end with a version path
  const chatUrl = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model: label.model,
    messages: messages.map(m => ({ role: m.role, content: serializeContent(m.content) })),
  };
  if (opts.maxTokens != null) body['max_tokens'] = opts.maxTokens;
  const rawTemp = label.temperature ?? opts.temperature;
  if (rawTemp != null) body['temperature'] = rawTemp;
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
    const errText = sanitizeErrText(await res.text().catch(() => ''));
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
    // 回落到 reasoning_content 只对"中继把答案塞进了 reasoning 字段"这一种情况成立。
    // 无法区分"reasoning 里是答案"和"reasoning 里是思维链"时,把 CoT 当正文返回会一路走到
    // parser 的纯文本兜底 → 内心独白被发进群。所以只接受**看起来像结构化回复**的 reasoning
    // (JSON / 代码块包裹的 JSON / <response> 标签),其余一律当空响应,让 fallback 换 label、
    // 让 reply.ts 的空响应重试真正生效。
    fullText = rawContent.trim() ? rawContent : (looksLikeStructuredReply(rawReasoning) ? rawReasoning : '');
    if (!rawContent.trim() && rawReasoning.trim()) {
      logger.info(
        {
          label: label.name,
          model: label.model,
          reasoningChars: rawReasoning.length,
          accepted: fullText.length > 0,
        },
        fullText.length > 0
          ? 'AI empty content — using structured reasoning_content'
          : 'AI empty content — reasoning_content looks like raw CoT, treating as empty',
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
    const text = stripThinkingBlocks(fullText);
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
  const text = stripThinkingBlocks(fullText);

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

/**
 * reasoning_content 是否长得像"结构化回复"而不是裸思维链。
 * 保守:只认 JSON 对象 / ```json 围栏 / <response> 标签这三种回复契约形态。
 */
function looksLikeStructuredReply(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (t.startsWith('{') && t.endsWith('}')) return true;
  if (/^```(?:json)?\s*\{[\s\S]*\}\s*```$/.test(t)) return true;
  if (/<response>[\s\S]*<\/response>/i.test(t)) return true;
  if (/"reply_?[cC]ontent"\s*:/.test(t)) return true;
  // Dream journal / directive contracts: first line WRITE|SKIP (not bare CoT prose).
  if (/^(WRITE|SKIP)\b/im.test(t)) return true;
  return false;
}

/**
 * 剥掉思维链块。除了成对的 <think>/<thinking>,还要处理**未闭合**的前缀 ——
 * maxTokens 在思考中途截断时 content 就是 `<think>让我想想…`(没有 </think>),
 * 原来的成对正则不匹配,于是带 <think> 字样的内心独白被当正文发出去。
 */
function stripThinkingBlocks(s: string): string {
  let out = s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/◁think▷[\s\S]*?◁\/think▷/gi, '');
  // 未闭合的开标签 → 之后全部是思考内容,整段丢弃。
  out = out.replace(/<think(?:ing)?>[\s\S]*$/i, '').replace(/◁think▷[\s\S]*$/i, '');
  return out.trim();
}

export async function callModel(
  label: AILabel,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | ContentPart[] }>,
  opts: { maxTokens?: number; temperature?: number; timeout?: number; signal?: AbortSignal; jsonMode?: boolean } = {},
): Promise<AICallResult> {
  // 客户端并发闸：别把 provider 的限额撞爆（见 concurrency.ts 的实测数据）。
  // 按 (endpoint, apiKey) 分组——同一账号共享额度，不同账号各算各的。
  const cKey = `${label.endpoint}|${label.apiKeys[0] ?? ''}`;
  const release = await acquireConcurrency(cKey, AI_MAX_CONCURRENCY_PER_ACCOUNT);
  try {
    return await callModelInner(label, messages, opts);
  } finally {
    release();
  }
}

async function callModelInner(
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

  // 带媒体（图片/音频/视频）时**不走 claude 分支**，哪怕 label 声明了 FORMAT=claude。
  //
  // 2026-09-21 发现的静默 bug：下面那个 claude 分支把 content parts 映射成
  // `p.type === 'text' ? p.text : ''` —— 图片、音频、视频**全被换成空字符串**。
  // 调用方以为发了图，模型只收到文字，于是回"我没看到图片/视频呀"，
  // 而 prompt token 数也对得上（只有文字那部分）。没有任何报错。
  //
  // 而 StepFun 的 /step_plan/v1 同时提供 /messages（Anthropic 格式）和
  // /chat/completions（OpenAI 兼容），后者**收 video_url**（实测 step-5-preview
  // 可以；Anthropic 原生 video block 在那个端点上回 400 input_invalid）。
  // 所以带媒体就统一走 OpenAI 兼容的裸路径，让 serializeContent 去映射。
  const carriesMedia = hasMediaContent(messages);
  if (label.apiFormat === 'claude' && !carriesMedia) {
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
      temperature: label.temperature ?? opts.temperature,
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
