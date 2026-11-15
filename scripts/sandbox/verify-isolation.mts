import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runCodeActSandbox, preflightCodeActIsolation } from '../../src/sandbox/codeact/runner.js';
import type { CodeActProfile } from '../../src/sandbox/codeact/profile.js';
import type { CodeActCapability } from '../../src/sandbox/codeact/capabilities.js';

if (existsSync('.env')) throw new Error('Run this proof from an isolated staging checkout without .env');
const path = process.argv[2];
if (!path) throw new Error('Pass an explicit trusted sandbox profile JSON');
const profile = JSON.parse(await readFile(path, 'utf8')) as CodeActProfile;
const canaryDir = await mkdtemp(join(tmpdir(), 'nyat-codeact-proof-'));
const canary = join(canaryDir, 'host-only.txt');
await writeFile(canary, 'synthetic-host-canary');
const capabilities = new Map<string, CodeActCapability>();
const run = (code: string, timeoutMs = 3000) => runCodeActSandbox(profile, code, capabilities, { timeoutMs });
let passed = 0;
const proof = async (name: string, test: () => Promise<void>) => { await test(); console.log(`PASS ${++passed}: ${name}`); };
try {
  await proof('real preflight, no host capabilities', async () => {
    assert.deepEqual(await preflightCodeActIsolation(profile), { available: true });
  });
  await proof('serial RPC, return value and unawaited calls', async () => {
    const order: number[] = [];
    capabilities.set('test.add', async (value) => { await new Promise(resolve => setTimeout(resolve, 5)); order.push(Number(value)); return Number(value) + 1; });
    const result = await run('test.add(1); const n = await test.add(2); return n;');
    assert.equal(result.value, 3);
    assert.deepEqual(order, [1, 2]);
    capabilities.clear();
  });
  await proof('privilege drop and empty environment', async () => {
    process.env['SYNTHETIC_PARENT_SECRET'] = 'never-in-guest';
    const { value } = await run('return { uid: process.getuid(), secret: process.env.SYNTHETIC_PARENT_SECRET ?? null, cwd: process.cwd() };');
    assert.deepEqual(value, { uid: 65534, secret: null, cwd: '/' });
    delete process.env['SYNTHETIC_PARENT_SECRET'];
  });
  await proof('host file and proc-root escape inaccessible, filesystem read-only', async () => {
    const { value } = await run(`const fs = process.getBuiltinModule('fs');
      let wrote = false; try { fs.writeFileSync('/tmp/probe', 'no'); wrote = true; } catch {}
      return { canary: fs.existsSync(${JSON.stringify(canary)}), procEscape: fs.existsSync('/proc/1/root' + ${JSON.stringify(canary)}), wrote };`);
    assert.deepEqual(value, { canary: false, procEscape: false, wrote: false });
    assert.equal(await readFile(canary, 'utf8'), 'synthetic-host-canary');
  });
  await proof('kernel denies sockets without any real external traffic', async () => {
    const { value } = await run(`return await new Promise(resolve => {
      const socket = process.getBuiltinModule('net').connect({host:'127.0.0.1',port:9});
      socket.once('error', error => resolve(error.code));
      socket.once('connect', () => { socket.destroy(); resolve('unexpected-connect'); });
    });`);
    assert.ok(['EPERM', 'EACCES'].includes(String(value)), String(value));
  });
  await proof('kernel denies child process creation', async () => {
    const { value } = await run(`const child = process.getBuiltinModule('child_process').spawnSync(process.execPath, ['-e','process.exit(0)']); return child.error?.code ?? 'unexpected-spawn';`);
    assert.ok(['EPERM', 'EACCES'].includes(String(value)), String(value));
  });
  await proof('infinite JS loop is killed without blocking host timers', async () => {
    let hostTicked = false;
    const timer = setTimeout(() => { hostTicked = true; }, 20);
    await assert.rejects(run('while (true) {}', 150), /codeact_timeout/);
    clearTimeout(timer);
    assert.equal(hostTicked, true);
  });
  await proof('hard memory ceiling terminates or rejects excessive allocation', async () => {
    await assert.rejects(run('const held=[]; for(let i=0;i<32;i++) held.push(Buffer.alloc(64*1024*1024,1)); return "unbounded";', 5000), /codeact_guest_error|codeact_isolation_exit|codeact_timeout/);
  });
  await proof('unknown/prototype RPC cannot invoke host functions', async () => {
    let calls = 0;
    capabilities.set('test.safe', () => { calls++; });
    await assert.rejects(run(`process.stdout.write(JSON.stringify({type:'call',id:1,method:'test.constructor',args:[]})+String.fromCharCode(10)); await new Promise(()=>{});`), /capability_denied/);
    assert.equal(calls, 0);
    capabilities.clear();
  });
  await proof('unawaited RPC errors are reported, caught errors permit recovery', async () => {
    capabilities.set('test.fail', () => { throw new Error('expected-host-rejection'); });
    await assert.rejects(run('test.fail();'), /expected-host-rejection/);
    assert.equal((await run('try { await test.fail(); } catch {} return "recovered";')).value, 'recovered');
    capabilities.clear();
  });
  await proof('deadline drops queued capabilities', async () => {
    let lateCalls = 0;
    capabilities.set('test.wait', () => new Promise(resolve => setTimeout(resolve, 300)));
    capabilities.set('test.late', () => { lateCalls++; });
    await assert.rejects(run('test.wait(); test.late();', 150), /codeact_timeout/);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(lateCalls, 0);
    capabilities.clear();
  });
  await proof('send acknowledgement preserves useful text and structured fields', async () => {
    capabilities.set('test.ack', () => ({ messageId: 9, [Symbol.toPrimitive]: () => 'sent#9' }));
    assert.deepEqual((await run('const ack=await test.ack(); return [ack.messageId,String(ack)];')).value, [9, 'sent#9']);
    capabilities.clear();
  });
  await proof('concurrent Meta and worker requests share a real sequential guest queue', async () => {
    const order: number[] = [];
    capabilities.set('test.record', async (value) => {
      order.push(Number(value));
      await new Promise(resolve => setTimeout(resolve, 30));
      return Number(value);
    });
    const results = await Promise.all([run('return await test.record(1);'), run('return await test.record(2);')]);
    assert.deepEqual(results.map(result => result.value), [1, 2]);
    assert.deepEqual(order, [1, 2]);
    capabilities.clear();
  });
  console.log(JSON.stringify({ passed, profile: 'fixed OS isolation; fake capabilities only' }));
} finally {
  delete process.env['SYNTHETIC_PARENT_SECRET'];
  if (dirname(resolve(canaryDir)) === resolve(tmpdir()) && canaryDir.includes('nyat-codeact-proof-')) {
    await rm(canaryDir, { recursive: true, force: true });
  }
}
