import { z } from 'zod';
import type { PathPattern } from './path-patterns.js';
import type { ReplyPath } from '../shared/types.js';
import { callWithFallback } from '../ai/fallback.js';
import { loadPrompt, getConfig } from '../shared/config.js';

const ReflectionSchema = z.object({
  shouldLearn: z.boolean(),
  targetReplyPath: z.enum(['direct', 'planned']),
  pattern: z.enum(['realtime_info', 'link_inspect', 'market_quote', 'followup_lookup']),
  confidence: z.number().min(0).max(1),
  reason: z.string().default(''),
});

export type PathReflectionResult = z.infer<typeof ReflectionSchema>;

export function parsePathReflectionResponse(raw: string): PathReflectionResult {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  cleaned = cleaned.trim();
  const parsed = JSON.parse(cleaned) as unknown;
  return ReflectionSchema.parse(parsed);
}

export async function reviewPathDecision(input: {
  messageText: string;
  replyText: string;
  effectiveReplyPath: ReplyPath;
  matchedPatterns: PathPattern[];
  toolsUsed: string[];
  toolExecutionFailed: boolean;
}): Promise<PathReflectionResult> {
  const config = getConfig();
  const systemPrompt = loadPrompt('task/path-reflection.md', config.promptsDir);
  const result = await callWithFallback({
    usage: 'path_reflection',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          `[MESSAGE]\n${input.messageText || '[空消息]'}`,
          `[REPLY]\n${input.replyText || '[空回复]'}`,
          `[CURRENT_PATH]\n${input.effectiveReplyPath}`,
          `[MATCHED_PATTERNS]\n${input.matchedPatterns.join('\n') || '[none]'}`,
          `[TOOLS_USED]\n${input.toolsUsed.join('\n') || '[none]'}`,
          `[TOOL_EXECUTION_FAILED]\n${input.toolExecutionFailed ? 'true' : 'false'}`,
        ].join('\n\n'),
      },
    ],
    maxTokens: 200,
    temperature: 0,
  });
  return parsePathReflectionResponse(result.content);
}
