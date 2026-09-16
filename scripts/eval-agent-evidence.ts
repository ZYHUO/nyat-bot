import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { validateAcceptance, type AcceptanceContract } from '../src/agent/task-evidence.js';

const exec = promisify(execFile);
type Status = 'verified' | 'failed' | 'unverified';
interface EvaluationCase { name: string; expected: Status; actual: Status; passed: boolean }

/** Real files + independently declared acceptance. This measures the harness, NOT an LLM. */
export async function runEvidenceEvaluation() {
  const root = await mkdtemp(join(tmpdir(), 'nyat-evidence-eval-'));
  const cases: EvaluationCase[] = [];
  const check = async (name: string, expected: Status, contract?: AcceptanceContract) => {
    const result = await validateAcceptance(root, contract);
    cases.push({ name, expected, actual: result.status, passed: result.status === expected });
    return result;
  };
  try {
    await check('completion-without-contract', 'unverified');
    await check('empty-contract-is-not-success', 'unverified', { source: 'caller', checks: [] });
    const jsonContract: AcceptanceContract = { source: 'caller', checks: [
      { kind: 'json_field', path: 'result.json', field: ['sum'], equals: 55 },
    ] };
    await check('missing-artifact', 'failed', jsonContract);
    await writeFile(join(root, 'result.json'), '{bad json');
    await check('malformed-artifact', 'failed', jsonContract);
    // A real isolated child process produces the artifact; no API or model output is faked.
    await exec(process.execPath, ['-e',
      "require('fs').writeFileSync('result.json', JSON.stringify({sum:Array.from({length:10},(_,i)=>i+1).reduce((a,b)=>a+b,0)}))"],
      { cwd: root, timeout: 5000 });
    await check('real-command-json-computation', 'verified', jsonContract);
    await check('model-self-check-not-independent', 'unverified', { ...jsonContract, source: 'model' });
    await writeFile(join(root, 'result.json'), JSON.stringify({ sum: 54 }));
    await check('wrong-output-is-failure', 'failed', jsonContract);
    await exec(process.execPath, ['-e',
      "require('fs').writeFileSync('result.json',JSON.stringify({sum:10*11/2}))"], { cwd: root, timeout: 5000 });
    await check('failed-check-then-repair', 'verified', jsonContract);
    await writeFile(join(root, 'report.csv'), 'item,value\na,2\nb,3\n');
    await check('artifact-digest', 'verified', { source: 'caller', checks: [
      { kind: 'sha256', path: 'report.csv', equals: createHash('sha256').update('item,value\na,2\nb,3\n').digest('hex') },
    ] });
    await check('partial-delivery', 'failed', { source: 'caller', checks: [
      { kind: 'nonempty_file', path: 'report.csv' }, { kind: 'nonempty_file', path: 'missing.md' },
    ] });
    await writeFile(join(root, 'empty.txt'), '');
    await check('empty-file', 'failed', { source: 'caller', checks: [{ kind: 'nonempty_file', path: 'empty.txt' }] });
    await check('path-escape-rejected', 'failed', { source: 'caller', checks: [{ kind: 'nonempty_file', path: '../escape.txt' }] });
    await symlink('/etc/passwd', join(root, 'escape-link'));
    await check('symlink-escape-rejected', 'failed', { source: 'caller', checks: [{ kind: 'nonempty_file', path: 'escape-link' }] });
    return { kind: 'engineering_acceptance_not_agi_benchmark' as const,
      cases, passed: cases.filter((c) => c.passed).length, failed: cases.filter((c) => !c.passed).length };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runEvidenceEvaluation();
  console.log(JSON.stringify(report, null, 2));
  if (report.failed) process.exitCode = 1;
}
