// Local operator activation only. It never fabricates a platform update,
// connects a bot, calls a model, or starts a background worker.
import { config as loadDotenv } from 'dotenv';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

process.umask(0o077);
loadDotenv({ quiet: true });
const { logger } = await import('../src/shared/logger.js');
logger.level = 'silent';
const { closeDb } = await import('../src/db/sqlite.js');
try {
  const { activateLifeProject, cancelLifeProject } = await import('../src/agent/life-project.js');
  const [action, ...args] = process.argv.slice(2);
  if (action === 'activate' && args.length === 1) {
    const path = resolve(args[0]!); const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > 8192 || realpathSync(path) !== path
      || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('private_activation_file_required');
    const input: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_activation_config');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => !['chatId', 'objective', 'operatorRef', 'maxAttempts'].includes(key))
      || typeof value['chatId'] !== 'number' || !Number.isSafeInteger(value['chatId']) || value['chatId'] <= 0
      || typeof value['objective'] !== 'string' || typeof value['operatorRef'] !== 'string'
      || (value['maxAttempts'] !== undefined && typeof value['maxAttempts'] !== 'number')) throw new Error('invalid_activation_config');
    const project = activateLifeProject({ chatId: value['chatId'], objective: value['objective'], operatorRef: value['operatorRef'],
      ...(typeof value['maxAttempts'] === 'number' ? { maxAttempts: value['maxAttempts'] } : {}) });
    console.log(JSON.stringify({ ok: true, projectId: project.id, missionId: project.mission_id, status: project.status,
      attemptsStarted: project.attempts_started, maxAttempts: project.max_attempts, notifications: 'disabled', source: 'operator_config' }));
  } else if (action === 'cancel' && args.length === 2 && /^[a-f0-9-]{36}$/.test(args[0]!) && Number.isSafeInteger(Number(args[1]))) {
    if (!cancelLifeProject(args[0]!, Number(args[1]))) throw new Error('project_not_cancellable_in_owner_scope');
    console.log(JSON.stringify({ ok: true, projectId: args[0], status: 'cancelled' }));
  } else throw new Error('usage_activate_private_config_or_cancel_project_chat');
} catch {
  // Neither objective nor caller data nor configuration is printed on failure.
  console.error(JSON.stringify({ ok: false, reason: 'life_project_operator_action_failed' }));
  process.exitCode = 1;
} finally { closeDb(); }
