// Multi-Agent A/B: orchestrator vs single writer, on identical real chat inputs.
//
// The question this answers: does the multi-agent fan-out (specialists + critic
// + persona-critic) actually produce better replies than one plain writer call
// on the same message and context — or is it cost without benefit?
//
// Design constraints:
// - Live LLM calls cost quota, so this is opt-in via NYAT_LIVE_ENV (same gate as
//   scripts/eval-holdout-live.ts) and never runs in CI.
// - Judging "better" with the same model family is circular, so this harness
//   reports BOTH an LLM preference vote AND objective cost/latency deltas. A win
//   that only exists in the vote is not a win.
// - Inputs come from real production messages (`message in` previews), not
//   synthetic prompts, so the comparison reflects actual group traffic.
//
// Usage:
//   NYAT_LIVE_ENV=/root/xxb-ts/.env tsx scripts/ab-multiagent.ts [--samples 12]

import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'dotenv';

interface Sample {
  chatId: number;
  messageId: number;
  preview: string;
}

interface Arm {
  name: string;
  replies: string[];
  llmCalls: number;
  latencyMs: number;
  failed: boolean;
}

interface VoteResult {
  winner: 'A' | 'B' | 'tie';
  reason: string;
}

const envPath = process.env['NYAT_LIVE_ENV'];
if (!envPath) {
  throw new Error(
    'Set NYAT_LIVE_ENV=/root/xxb-ts/.env to explicitly opt into the live A/B run',
  );
}

const config = parse(await readFile(envPath, 'utf8'));
const prefix = 'AI_PROVIDER_STEPFUN_';
const endpoint = config[`${prefix}ENDPOINT`];
const key = config[`${prefix}KEY`];
const model = config[`${prefix}MODEL`];
if (!endpoint || !key || !model) {
  throw new Error('Required provider configuration missing (AI_PROVIDER_STEPFUN_*)');
}
const url = endpoint.replace(/\/$/, '').replace(/\/messages$/, '') + '/messages';

/**
 * Extract visible text from a Claude-format response.
 *
 * step-3.7-flash returns `thinking` blocks that can consume the whole token
 * budget, so a parser that only reads `type === 'text'` silently sees an empty
 * string and every vote degrades to a bogus "tie". Skip thinking blocks
 * explicitly and report whether any text was found at all.
 */
function extractText(json: unknown): { text: string; sawOnlyThinking: boolean } {
  const content = (json as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return { text: '', sawOnlyThinking: false };
  const texts = content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string);
  const thinking = content.filter((c) => c.type === 'thinking');
  return {
    text: texts.join('').trim(),
    sawOnlyThinking: texts.length === 0 && thinking.length > 0,
  };
}

const args = process.argv.slice(2);
const sampleArgIndex = args.indexOf('--samples');
const sampleCount = sampleArgIndex >= 0 ? Number(args[sampleArgIndex + 1]) : 12;
const LOG_PATH = process.env['NYAT_AB_LOG'] ?? 'logs/app.log';

const VOTE_SYSTEM =
  '你是群里的人类观察者。下面两条回复来自不同的机器人实现。' +
  '选更像真人在群聊里会说的那条:更自然、更接话、不油腻、不自嗨。' +
  // Ask for the verdict FIRST and cap the budget: with a reasoning model the
  // verdict can otherwise be crowded out by thinking tokens before it appears.
  '第一个字符必须是判定结果,只能是 A、B、T 之一,然后换行写一句理由。' +
  '不要输出其他任何内容,不要思考过程。';

/**
 * Tokens allowed for a vote.
 *
 * Do NOT shrink this: step-3.7-flash emits a leading `thinking` block, and if
 * the budget runs out inside it there is no `text` block at all. Measured on
 * this endpoint: 40 tokens -> thinking-only, empty text; 800 tokens -> a
 * thinking block (~200 tokens) followed by the actual verdict. A starved vote
 * budget silently produced a fake "all ties" result the first time this ran.
 */
const VOTE_MAX_TOKENS = 800;


/** Pull real non-command group messages out of the production log. */
function loadSamples(limit: number): Sample[] {
  const out: Sample[] = [];
  const seen = new Set<number>();
  const perChat = new Map<number, number>();
  const MAX_PER_CHAT = 3;
  const raw = readFileSync(LOG_PATH, 'utf8');
  // Collect candidates first, then round-robin across chats so one noisy DM
  // cannot dominate the sample set.
  const candidates: Sample[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row['msg'] !== 'message in') continue;
    const preview = typeof row['preview'] === 'string' ? row['preview'].trim() : '';
    const chatId = row['chatId'];
    const messageId = row['messageId'];
    if (!preview || preview.startsWith('/')) continue;
    if (typeof chatId !== 'number' || typeof messageId !== 'number') continue;
    if (seen.has(messageId)) continue;
    // Skip boilerplate that is not a real conversational turn.
    if (/入群验证|验证已过期|已被封禁|Welcome|欢迎 .*加入群组/.test(preview)) continue;
    if (preview === '[sticker/图/附件]') continue;
    // Skip other bots' own machine output — we want human turns to react to.
    if (/^[⏳🎯🎉🧵🚫⚠️⏱️🎲🔍📊]/.test(preview)) continue;
    if (/测试任务|任务提交成功|选择测试|已禁言|警告\d+次|测试耗时|总体耗时/.test(preview)) continue;
    // Skip our own bot's visible output echoed back into the log.
    if (/^欢迎 .*进群喵|请多指教喵/.test(preview)) continue;
    // Keep group traffic (chatId < 0) — group chat is the target behavior.
    if (chatId > 0) continue;
    if (preview.length < 4) continue;
    seen.add(messageId);
    candidates.push({ chatId, messageId, preview: preview.slice(0, 200) });
  }
  // Round-robin: take up to MAX_PER_CHAT from each chat, newest first.
  for (const sample of candidates) {
    const used = perChat.get(sample.chatId) ?? 0;
    if (used >= MAX_PER_CHAT) continue;
    perChat.set(sample.chatId, used + 1);
    out.push(sample);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Claude-format body shared by every call in this harness.
 *
 * `thinking: { type: 'disabled' }` mirrors what production does for labels that
 * set `disableThinking` (src/ai/provider.ts:214). Without it the reasoning
 * model can spend the whole budget on a thinking block and return no text at
 * all, which silently turns every comparison into a fake "tie".
 */
function claudeBody(args: {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}): Record<string, unknown> {
  return {
    model,
    max_tokens: args.maxTokens,
    temperature: args.temperature,
    system: args.system,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: args.user }],
  };
}

/** One plain writer call (the "single model" arm). */
async function callWriter(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; calls: number }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify(
      claudeBody({
        system: systemPrompt,
        user: userPrompt,
        maxTokens: 800,
        temperature: 0.9,
      }),
    ),
  });
  if (!res.ok) return { text: '', calls: 1 };
  const json = await res.json();
  // Thinking blocks are skipped; if the budget was consumed by reasoning the
  // text comes back empty and the arm is reported as failed rather than as a
  // silently bad reply.
  const { text } = extractText(json);
  return { text, calls: 1 };
}

/** The orchestrator arm: specialists fan-out + writer, mirroring orchestrator.ts. */
async function callOrchestrated(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; calls: number; specialistNotes: string[] }> {
  const notes: string[] = [];
  let calls = 0;

  // Stage 1: memory + persona specialists run in parallel (judge-tier usage).
  const specialistSpecs: Array<{ name: string; prompt: string }> = [
    {
      name: 'memory',
      prompt: `你是记忆员。判断这条消息是否需要引用群内历史记忆,若需要则给一句最相关的回忆,否则输出"-"。\n消息: ${userPrompt}`,
    },
    {
      name: 'persona',
      prompt: `你是人设员。针对这条消息,给出说话者最可能的情绪与最合适的语气基调,一句话。\n消息: ${userPrompt}`,
    },
  ];
  const specialistResults = await Promise.all(
    specialistSpecs.map(async (spec) => {
      const r = await callWriter('你是群聊认知专家,输出极简。', spec.prompt);
      calls += 1;
      return { name: spec.name, text: r.text };
    }),
  );
  for (const r of specialistResults) if (r.text) notes.push(`[${r.name}] ${r.text}`);

  // Stage 2: writer with specialist context.
  const writerPrompt = notes.length
    ? `${userPrompt}\n\n[专家线索]\n${notes.join('\n')}`
    : userPrompt;
  const written = await callWriter(systemPrompt, writerPrompt);
  calls += 1;

  // Stage 3: critic (judge) approves or rewrites.
  const critic = await callWriter(
    '你是审稿人。若回复不合格,给出一句修改意见;合格则输出"OK"。',
    `消息: ${userPrompt}\n回复: ${written.text}\n\n评价:`,
  );
  calls += 1;
  const feedback = critic.text.trim();
  if (feedback && !/^ok$/i.test(feedback)) {
    const rewrite = await callWriter(
      systemPrompt,
      `${userPrompt}\n\n[审稿反馈]\n${feedback}\n\n请据此重写:`,
    );
    calls += 1;
    return { text: rewrite.text || written.text, calls, specialistNotes: notes };
  }
  return { text: written.text, calls, specialistNotes: notes };
}

/** Blind preference vote between the two arms. */
async function vote(
  userPrompt: string,
  a: string,
  b: string,
): Promise<VoteResult> {
  const body = claudeBody({
    system: VOTE_SYSTEM,
    user: `[群里的消息]\n${userPrompt}\n\n[A]\n${a}\n\n[B]\n${b}\n\n回复 A / B / T 开头:`,
    maxTokens: VOTE_MAX_TOKENS,
    temperature: 0,
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { winner: 'tie', reason: `vote_http_${res.status}` };
    const json = await res.json();
    const { text, sawOnlyThinking } = extractText(json);
    if (!text) {
      // A vote that could not be read is NOT a tie. Surface it so the summary
      // cannot report a false preference distribution.
      return {
        winner: 'tie',
        reason: sawOnlyThinking ? 'vote_unreadable_thinking_only' : 'vote_unreadable_empty',
      };
    }
    const head = text.trim().toUpperCase();
    const winner = head.startsWith('A') ? 'A' : head.startsWith('B') ? 'B' : 'tie';
    const reason = text.split('\n').slice(1).join(' ').trim().slice(0, 120);
    return { winner, reason: reason || text.slice(0, 120) };
  } catch {
    return { winner: 'tie', reason: 'vote_error' };
  }
}

/** True when a tie came from an unreadable vote rather than a real judgement. */
function isUnreadableTie(row: Record<string, unknown>): boolean {
  return (
    row['vote'] === 'tie' &&
    typeof row['voteReason'] === 'string' &&
    row['voteReason'].startsWith('vote_unreadable')
  );
}

async function main(): Promise<void> {
  const samples = loadSamples(sampleCount);
  if (samples.length === 0) {
    console.error('No samples found — check NYAT_AB_LOG path');
    process.exitCode = 1;
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'nyat-ab-'));
  const rows: Array<Record<string, unknown>> = [];

  const SYSTEM =
    '你是啾咪囝,群里的猫娘成员,不是客服。用真人在群里说话的方式回一句,不要排比、不要清单、不要解释自己。';

  for (const sample of samples) {
    const userPrompt = sample.preview;
    // Arm A: single writer. Arm B: orchestrated fan-out.
    const aStart = Date.now();
    const a = await callWriter(SYSTEM, userPrompt);
    const aMs = Date.now() - aStart;

    const bStart = Date.now();
    const b = await callOrchestrated(SYSTEM, userPrompt);
    const bMs = Date.now() - bStart;

    const v = await vote(userPrompt, a.text, b.text);
    rows.push({
      chatId: sample.chatId,
      messageId: sample.messageId,
      input: userPrompt,
      singleWriter: a.text,
      orchestrated: b.text,
      singleCalls: a.calls,
      orchestratedCalls: b.calls,
      singleMs: aMs,
      orchestratedMs: bMs,
      specialistNotes: b.specialistNotes,
      vote: v.winner,
      voteReason: v.reason,
    });
    process.stdout.write(
      `[${rows.length}/${samples.length}] vote=${v.winner} calls ${a.calls}→${b.calls} ms ${aMs}→${bMs}\n`,
    );
  }

  // Summary: preference alone is not evidence; report cost alongside it.
  const unreadable = rows.filter(isUnreadableTie).length;
  const decided = rows.length - unreadable;
  const winsA = rows.filter((r) => r['vote'] === 'A').length;
  const winsB = rows.filter((r) => r['vote'] === 'B').length;
  const ties = decided - winsA - winsB;
  const meanCallsA = rows.reduce((s, r) => s + Number(r['singleCalls']), 0) / rows.length;
  const meanCallsB = rows.reduce((s, r) => s + Number(r['orchestratedCalls']), 0) / rows.length;
  const meanMsA = rows.reduce((s, r) => s + Number(r['singleMs']), 0) / rows.length;
  const meanMsB = rows.reduce((s, r) => s + Number(r['orchestratedMs']), 0) / rows.length;

  // A run whose votes were mostly unreadable proves nothing about quality. It
  // may still justify removal on cost grounds, but it must not masquerade as a
  // quality comparison.
  const verdict =
    decided === 0
      ? 'INCONCLUSIVE — no readable votes; cost data only'
      : winsB <= winsA
        ? `orchestrator_not_better (${winsB} vs ${winsA} of ${decided} decided) — removing it is justified`
        : `orchestrator_won_${winsB}_of_${decided} — keep only if latency is acceptable`;

  const summary = {
    samples: rows.length,
    votesReadable: decided,
    votesUnreadable: unreadable,
    preference: { singleWriter: winsA, orchestrated: winsB, tie: ties },
    cost: {
      meanLlmCalls: { singleWriter: meanCallsA, orchestrated: meanCallsB },
      meanLatencyMs: { singleWriter: meanMsA, orchestrated: meanMsB },
      callMultiplier: meanCallsA ? meanCallsB / meanCallsA : null,
      latencyMultiplier: meanMsA ? meanMsB / meanMsA : null,
    },
    verdict,
  };

  const outPath = join(dir, 'ab-multiagent.json');
  await writeFile(outPath, JSON.stringify({ summary, rows }, null, 2), 'utf8');
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nFull detail: ${outPath}`);
}

await main();
