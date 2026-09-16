import { z } from 'zod';
import { tool } from 'ai';
import type { Tool } from 'ai';
import { explainJargon } from '../../learners/jargon-explainer.js';
import { env } from '../../env.js';

const jargonSchema = z.object({
  term: z.string().describe('要查询的黑话/缩写/网络用语'),
});

export function buildJargonTool(chatId: number): { name: string; schema: typeof jargonSchema; tool: Tool } | null {
  if (!env().JARGON_QUERY_ENABLED) return null;

  return {
    name: 'QUERY_JARGON',
    schema: jargonSchema,
    tool: tool({
      description: '查询群内黑话/缩写/网络用语的含义。当你看到不理解的词汇时使用。',
      parameters: jargonSchema,
      execute: async ({ term }) => explainJargon(chatId, term),
    }),
  };
}
