import { getChatState } from '../timing/chat-runtime.js';

/** Host fence shared by the actor and each logical recovery send. */
export async function isWaitRecoveryCurrent(chatId: number, context?: {
  isWaitReplay?: boolean;
  sleepCatchup?: boolean;
  waitGeneration?: string;
}): Promise<boolean> {
  if (!context?.isWaitReplay || context.sleepCatchup) return true;
  if (!context.waitGeneration) return false;
  try {
    const state = await getChatState(chatId);
    return state.state === 'RUNNING' && state.waitGeneration === context.waitGeneration;
  } catch {
    return false;
  }
}
