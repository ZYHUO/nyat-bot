import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { OFFLINE_SUITES, verifyOfflineReport } from '../../../scripts/verify-integration.mts';

const report = () => ({ success: true, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0, numPassedTests: OFFLINE_SUITES.length,
  testResults: OFFLINE_SUITES.map(name => ({ name: resolve(name), status: 'passed', assertionResults: [{ status: 'passed' }] })) });

describe('explicit offline integration verification', () => {
  it('requires every named suite and assertion, rejecting skips, missing cases and invented totals', () => {
    expect(verifyOfflineReport(report())).toBe(OFFLINE_SUITES.length);
    for (const change of [
      (r: ReturnType<typeof report>) => { r.success = false; },
      (r: ReturnType<typeof report>) => { r.testResults.pop(); },
      (r: ReturnType<typeof report>) => { r.testResults[0] = r.testResults[1]!; },
      (r: ReturnType<typeof report>) => { r.numPendingTests = 1; },
      (r: ReturnType<typeof report>) => { r.testResults[0]!.assertionResults[0]!.status = 'skipped'; },
      (r: ReturnType<typeof report>) => { r.numPassedTests += 1; },
    ]) {
      const candidate = report(); change(candidate); expect(() => verifyOfflineReport(candidate)).toThrow();
    }
  });

  it('refuses implicit live execution before loading application configuration', () => {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href,
      resolve('scripts/verify-integration.mts')], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    expect(result.status).toBe(64); expect(result.stderr).toContain('--offline'); expect(result.stdout).toBe('');
  });

  it('blocks real TCP, UDP and local IPC before they reach any server', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'nyatbot-guard-test-'));
    const cleanup = (): void => {
      if (dirname(temporary) !== tmpdir() || !basename(temporary).startsWith('nyatbot-guard-test-')) throw new Error('unsafe_fixture_cleanup');
      rmSync(temporary, { recursive: true, force: true });
    };
    try {
      const audit = join(temporary, 'audit.jsonl');
      const script = `const net=require('node:net'),dgram=require('node:dgram');
        let denied=0;try{net.connect({host:'127.0.0.1',port:6379});}catch(e){if(e.message==='OFFLINE_INTEGRATION_NETWORK_DENIED')denied++;}
        const udp=dgram.createSocket('udp4');try{udp.send('fixture',53,'127.0.0.1');}catch(e){if(e.message==='OFFLINE_INTEGRATION_NETWORK_DENIED')denied++;}finally{udp.close();}
        net.connect({path:'fixture-unopened-local-pipe'}).on('error',e=>{if(e.code!=='ECONNREFUSED'||denied!==2)process.exitCode=1;else console.log('boundaries-held');});`;
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(resolve('scripts/offline-network-guard.mjs')).href, '-e', script],
        { env: { ...process.env, NYATBOT_OFFLINE_INTEGRATION: '1', NYATBOT_OFFLINE_AUDIT: audit }, encoding: 'utf8', timeout: 10_000, windowsHide: true });
      expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('boundaries-held');
      const events = readFileSync(audit, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string });
      expect(events.filter(event => event.kind === 'network_denied')).toHaveLength(2);
      expect(events.filter(event => event.kind === 'ipc_blocked')).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
