import { env } from '../env.js';
import { configuredCodeActProfile, preflightCodeActIsolation } from '../sandbox/codeact/runner.js';

/** Verify the real service identity before starting ingress or consuming tasks. */
export async function assertMetaIsolationReady(): Promise<void> {
  const config = env();
  if (!config.META_SUBAGENT_ENABLED) return;
  if (!Number.isSafeInteger(config.META_ACTIVATED_AT_SEC) || config.META_ACTIVATED_AT_SEC <= 0
    || config.META_ACTIVATED_AT_SEC > Math.floor(Date.now() / 1000)) throw new Error('meta_activation_epoch_required');
  const result = await preflightCodeActIsolation(configuredCodeActProfile());
  if (!result.available) throw new Error(`meta_isolation_preflight_failed: ${result.reason ?? 'unavailable'}`);
}
