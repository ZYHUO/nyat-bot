/** Explicit offline composition checks. Never imports application code in the launcher. */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const OFFLINE_SUITES = [
  'tests/unit/meta/telegram-heart-ingress.test.ts',
  'tests/unit/meta/telegram-heart-batch.test.ts',
  'tests/unit/pipeline/heart/batch-context.test.ts',
  'tests/unit/meta/wait-recheck.test.ts',
  'tests/unit/meta/wait-recheck-slot.test.ts',
  'tests/unit/subagent/wait-recovery-fence.test.ts',
  'tests/unit/queue/wait-worker.test.ts',
  'tests/integration/prompt-cache.test.ts',
  'tests/integration/sdk-tool-cache.test.ts',
  'tests/unit/ai/usage-normalization.test.ts',
  'tests/unit/ai/provider-cache.test.ts',
  'tests/unit/ai/openai-stream.test.ts',
  'tests/unit/pipeline/heart/cache-prefix.test.ts',
  'tests/unit/metrics/llm-events.test.ts',
  'tests/unit/metrics/token-ledger.test.ts',
  'tests/unit/admin/business-config.test.ts',
  'tests/unit/admin/update-requests.test.ts',
  'tests/unit/startup/readiness.test.ts',
  'tests/unit/subagent/local-codeact-shutdown.test.ts',
  'tests/unit/pipeline/tools/search-status.test.ts',
  'tests/unit/pipeline/tools/stepfun-search.test.ts',
  'tests/unit/nyatos/ad-pressure.test.ts',
  'tests/unit/nyatos/remedy.test.ts',
  'tests/unit/nyatos/body-signal.test.ts',
  'tests/integration/offline-composition.test.ts',
  'tests/unit/bot/handlers/meta-bot-gate.test.ts',
  'tests/unit/pipeline/bot-reply-delegation.test.ts',
  'tests/unit/ai/smart-group-autoassign.test.ts',
  'tests/unit/ai/jev.test.ts',
  'tests/unit/ai/inflight-cap-behaviour.test.ts',
  'tests/unit/memory/chroma-embed-weights.test.ts',
  'tests/unit/subagent/topic-repeat-production-replay.test.ts',
  'tests/unit/subagent/task-burst-gate-behaviour.test.ts',
  'tests/unit/subagent/capability-prompt.test.ts',
  'tests/unit/platform/onebot-flow.test.ts',
  'tests/unit/ai/config-audit-cli.test.ts',
] as const;

export function verifyOfflineReport(report: unknown): number {
  const r = report as { success?: unknown; numFailedTests?: number; numFailedTestSuites?: number;
    numPendingTests?: number; numTodoTests?: number; numPassedTests?: number;
    testResults?: Array<{ name: string; status: string; assertionResults?: Array<{ status: string }> }> };
  if (!r || r.success !== true || r.numFailedTests !== 0 || r.numFailedTestSuites !== 0
    || r.numPendingTests !== 0 || (r.numTodoTests ?? 0) !== 0 || !Number.isSafeInteger(r.numPassedTests) || r.numPassedTests! < 1
    || !Array.isArray(r.testResults) || r.testResults.length !== OFFLINE_SUITES.length) throw new Error('offline_checks_incomplete');
  const found = new Set<string>();
  for (const result of r.testResults) {
    const normalized = result.name.replaceAll('\\', '/');
    const suite = OFFLINE_SUITES.find(name => normalized.endsWith('/' + name));
    if (!suite || found.has(suite) || result.status !== 'passed' || !result.assertionResults?.length
      || result.assertionResults.some(test => test.status !== 'passed')) throw new Error('offline_suite_not_passed');
    found.add(suite);
  }
  if (r.testResults.reduce((total, suite) => total + suite.assertionResults!.length, 0) !== r.numPassedTests) {
    throw new Error('offline_pass_count_mismatch');
  }
  return r.numPassedTests!;
}

export function runOffline(): Record<string, unknown> {
  const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'nyatbot-offline-integration-')));
  const audit = join(temporary, 'network.jsonl');
  const cleanup = (): void => {
    if (dirname(temporary) !== realpathSync(tmpdir()) || !temporary.startsWith(join(realpathSync(tmpdir()), 'nyatbot-offline-integration-'))) {
      throw new Error('unsafe_fixture_cleanup');
    }
    rmSync(temporary, { recursive: true, force: true });
  };
  try {
    writeFileSync(join(temporary, 'empty.env'), '', { mode: 0o600 });
    writeFileSync(audit, '', { mode: 0o600 });
    // Do not inherit provider keys, Telegram/QQ credentials, production paths,
    // NODE_OPTIONS hooks, proxy settings, Redis URLs or the caller's .env.
    const childEnv: NodeJS.ProcessEnv = {};
    for (const name of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','HOME','USERPROFILE']) {
      if (process.env[name] !== undefined) childEnv[name] = process.env[name];
    }
    Object.assign(childEnv, {
      NODE_ENV: 'test', LOG_LEVEL: 'fatal', LOG_LEVEL_DYNAMIC: 'false', NO_COLOR: '1',
      BOT_TOKEN: '0000000000:TEST_TOKEN_FOR_VITEST_ONLY', BOT_USERNAME: 'fixture_bot',
      REDIS_URL: 'redis://127.0.0.1:1', SQLITE_PATH: join(temporary, 'fixture.db'), NYATDB_DIR: join(temporary, 'nyatdb'),
      DOTENV_CONFIG_PATH: join(temporary, 'empty.env'),
      NYATBOT_OFFLINE_INTEGRATION: '1', NYATBOT_OFFLINE_AUDIT: audit,
      NODE_OPTIONS: '--import=' + pathToFileURL(join(root, 'scripts/offline-network-guard.mjs')).href,
    });
    const resultPath = join(temporary, 'tests.json');
    const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...OFFLINE_SUITES,
      '--pool=forks', '--maxWorkers=2', '--reporter=json', '--outputFile=' + resultPath],
    { cwd: root, env: childEnv, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    const events = readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { kind: string; origin?: string[] });
    const denied = events.filter(event => event.kind === 'network_denied').length;
    if (denied || !events.some(event => event.kind === 'guard_loaded')) {
      console.error(JSON.stringify({ deniedNetworkAttempts: denied, origins: [...new Set(events.flatMap(event => event.origin ?? []))] }));
      throw new Error('offline_network_boundary_failed');
    }
    if (result.error || result.status !== 0) {
      try {
        const failed = JSON.parse(readFileSync(resultPath, 'utf8')) as { testResults: Array<{ name: string; status: string }> };
        console.error(JSON.stringify({ failedSuites: failed.testResults.filter(item => item.status !== 'passed')
          .map(item => OFFLINE_SUITES.find(name => item.name.replaceAll('\\', '/').endsWith('/' + name)) ?? 'unknown') }));
      } catch { /* No raw process stderr: it is not an acceptance report. */ }
      throw new Error('offline_composition_failed');
    }
    const passed = verifyOfflineReport(JSON.parse(readFileSync(resultPath, 'utf8')));
    return { success: true, mode: 'offline', suites: OFFLINE_SUITES.length, passed, skipped: 0,
      networkAttempts: 0, platformMessages: 0, productionStateAccess: false,
      boundary: 'Real application compositions with synthetic transport/provider/state fixtures; no live provider or delivery claim.' };
  } finally {
    // Only the unique directory returned by mkdtemp is removed, never configured data paths.
    cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--offline') {
    console.error('Usage: node --import tsx scripts/verify-integration.mts --offline; no implicit live mode.');
    process.exitCode = 64;
  } else {
    try { console.log(JSON.stringify(runOffline())); }
    catch (error) {
      const code = error instanceof Error && /^offline_[a-z_]+$/.test(error.message) ? error.message : 'offline_verification_failed';
      console.log(JSON.stringify({ success: false, mode: 'offline', code })); process.exitCode = 1;
    }
  }
}
