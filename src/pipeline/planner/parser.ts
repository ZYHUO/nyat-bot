import { z } from 'zod';
import type { ToolPlan } from './types.js';

const ToolPlanStepSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  purpose: z.string().min(1),
});

const ToolPlanSchema = z.object({
  needTools: z.boolean(),
  answerStrategy: z.enum(['direct', 'tool_then_answer']).default('tool_then_answer'),
  steps: z.array(ToolPlanStepSchema).max(3).default([]),
});

export function parsePlannerResponse(raw: string): ToolPlan {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/is, '').replace(/\s*```\s*$/is, '');
  cleaned = cleaned.trim();

  const parsed = JSON.parse(cleaned) as unknown;
  const plan = ToolPlanSchema.parse(parsed);

  if (!plan.needTools) {
    return {
      needTools: false,
      answerStrategy: 'direct',
      steps: [],
    };
  }

  return plan;
}
