import { executeValidatedToolStep } from '../tools/registry.js';
import type { ExecutedToolStep, ToolPlan } from './types.js';
import { logger } from '../../shared/logger.js';

export async function executeToolPlan(
  plan: ToolPlan,
  ctx: { chatId: number; userId: number },
): Promise<ExecutedToolStep[]> {
  const executed: ExecutedToolStep[] = [];

  for (const step of plan.steps) {
    let lastError: Error | undefined;
    let retries = 0;
    const maxRetries = 2; // Increased from 1 to 2

    while (retries <= maxRetries) {
      try {
        const output = await executeValidatedToolStep(
          step.tool,
          step.args,
          ctx.chatId,
          ctx.userId,
        );
        executed.push({
          ...step,
          output,
        });
        break; // Success, move to next step
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        retries++;

        // Determine if error is retryable
        const isRetryable = isRetryableError(lastError);

        if (retries > maxRetries || !isRetryable) {
          logger.warn({
            tool: step.tool,
            args: step.args,
            retries,
            isRetryable,
            err: lastError.message,
          }, 'Tool execution failed');
          throw lastError;
        }

        // Exponential backoff: 500ms, 1000ms
        const delayMs = 500 * retries;
        logger.debug({ tool: step.tool, retries, delayMs }, 'Retrying tool execution');
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  return executed;
}

/**
 * Determine if an error is worth retrying.
 * Network errors, timeouts, and rate limits are retryable.
 * Invalid arguments or not-found errors are not.
 */
function isRetryableError(err: Error): boolean {
  const msg = err.message.toLowerCase();

  // Retryable: network, timeout, rate limit
  if (msg.includes('timeout') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('rate limit') ||
      msg.includes('429') ||
      msg.includes('503') ||
      msg.includes('502')) {
    return true;
  }

  // Not retryable: validation, not found, permission
  if (msg.includes('invalid') ||
      msg.includes('not found') ||
      msg.includes('permission') ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden')) {
    return false;
  }

  // Default: retry unknown errors
  return true;
}

export function formatToolResultsForPrompt(steps: ExecutedToolStep[]): string {
  if (steps.length === 0) return '';

  const lines = steps.map((step, index) => {
    const rendered = typeof step.output === 'string'
      ? step.output
      : JSON.stringify(step.output, null, 2);
    return [
      `Step ${index + 1}`,
      `tool: ${step.tool}`,
      `purpose: ${step.purpose}`,
      `args: ${JSON.stringify(step.args)}`,
      `output:\n${rendered}`,
    ].join('\n');
  });

  return `[TOOL_RESULTS]\n${lines.join('\n\n')}`;
}
