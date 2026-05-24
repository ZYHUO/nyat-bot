export interface ToolPlanStep {
  tool: string;
  args: Record<string, unknown>;
  purpose: string;
}

export interface ToolPlan {
  needTools: boolean;
  answerStrategy: 'direct' | 'tool_then_answer';
  steps: ToolPlanStep[];
}

export interface PlannerInput {
  usage: string;
  messageText: string;
  context: string;
  knowledge?: string;
  availableTools?: string[];
}

export interface ExecutedToolStep extends ToolPlanStep {
  output: unknown;
}
