import { logger } from '../shared/logger.js';

const pending = new Set<Promise<void>>();
/** Preserve nonblocking ingress, but make its detached work joinable at shutdown. */
export function trackIngressTask(task: Promise<unknown>): void {
  const joined = task.then(() => {}, () => { logger.warn('Detached ingress work failed'); });
  pending.add(joined);
  void joined.finally(() => pending.delete(joined));
}
/** Call after transports have stopped admitting input. A hung task cannot be
 * turned into a clean checkpoint by a timeout here; the process watchdog owns failure. */
export async function drainIngressTasks(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
