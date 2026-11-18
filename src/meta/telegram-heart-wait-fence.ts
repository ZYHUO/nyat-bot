import { getDb } from '../db/sqlite.js';
import { env } from '../env.js';
import { getChatState } from '../pipeline/timing/chat-runtime.js';
import { resolveConversationScope } from '../shared/privacy-scope.js';
import { checkCodeActActivation } from '../subagent/activation-policy.js';
import { isTelegramHeartBatchChat } from './flags.js';
import { telegramHeartScopeKey } from './telegram-heart-store.js';
import type { WaitRecoveryFence } from './types.js';

type SourceWaitFence = Extract<WaitRecoveryFence, { authority: 'telegram_source' }>;
const MAX_DELIVERY_AGE_MS = 5 * 60_000;

function currentGeneration(accountId: string, chatId: number, threadId: number): string | undefined {
  const row = getDb().prepare('SELECT version FROM telegram_heart_scope_versions WHERE scope_key=?')
    .get(telegramHeartScopeKey(accountId, chatId, threadId)) as { version: number } | undefined;
  if (row && Number.isSafeInteger(row.version) && row.version > 0) return `tg-source-${row.version}`;
  return undefined;
}

/** Bind a re-evaluation to the actual topic version held when SQLite granted its claim. */
export function captureTelegramHeartWaitFence(chatId: number, threadId: number, expectedVersion?: number): SourceWaitFence | undefined {
  const scope = resolveConversationScope(chatId);
  const config = env(), now = Date.now();
  if (!scope?.accountId || scope.platform !== 'telegram' || scope.conversationKind !== 'group'
    || !Number.isSafeInteger(threadId) || threadId < 0 || !Number.isSafeInteger(expectedVersion)
    || !config.TIMING_GATE_ENABLED || !isTelegramHeartBatchChat(chatId)
    || !checkCodeActActivation({ chatId, createdAt: now }, config).allowed) return;
  const generation = currentGeneration(scope.accountId, chatId, threadId);
  if (generation !== `tg-source-${expectedVersion}`) return;
  return { authority: 'telegram_source', chatId, threadId, accountId: scope.accountId, platform: 'telegram', generation,
    activationEpoch: config.META_ACTIVATED_AT_SEC, expiresAt: now + MAX_DELIVERY_AGE_MS };
}

/** The caller has already checked the task's account, chat, and topic. Do the
 * async suppression check first so the final source/version read is synchronous. */
export async function isTelegramHeartWaitFenceCurrent(fence: SourceWaitFence): Promise<boolean> {
  if (fence.platform !== 'telegram' || !Number.isSafeInteger(fence.expiresAt)
    || fence.expiresAt <= Date.now() || (await getChatState(fence.chatId, true)).state !== 'RUNNING') return false;
  const remaining = fence.expiresAt - Date.now();
  const config = env();
  return config.TIMING_GATE_ENABLED && isTelegramHeartBatchChat(fence.chatId)
    && config.META_ACTIVATED_AT_SEC === fence.activationEpoch
    && checkCodeActActivation({ chatId: fence.chatId, createdAt: fence.expiresAt - MAX_DELIVERY_AGE_MS }, config).allowed
    && resolveConversationScope(fence.chatId)?.accountId === fence.accountId && remaining > 0 && remaining <= MAX_DELIVERY_AGE_MS
    && currentGeneration(fence.accountId, fence.chatId, fence.threadId) === fence.generation;
}
