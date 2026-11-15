/** Trusted bootstrap executed ONLY behind the OS sandbox. Never run it directly. */
export const CODEACT_GUEST_SOURCE = String.raw`
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const emit = message => process.stdout.write(JSON.stringify(message) + '\n');
if (process.getuid() === 0) {
  process.setgroups([]);
  process.setgid(65534);
  process.setuid(65534);
}
const status = fs.readFileSync('/proc/self/status', 'utf8');
const field = name => new RegExp('^' + name + ':\\s*(\\S+)', 'm').exec(status)?.[1];
if (process.getuid() === 0 || field('NoNewPrivs') !== '1' || field('Seccomp') !== '2'
    || !/^0+$/.test(field('CapEff') || '') || !/^0+$/.test(field('CapPrm') || '')) {
  throw new Error('codeact_isolation_attestation_failed');
}
const pending = new Map();
const issued = new Set();
let sequence = 0;
let started = false;
function unpack(wire) {
  if (wire.kind === 'undefined') return undefined;
  const value = wire.value;
  if (wire.display !== undefined && value && typeof value === 'object') {
    Object.defineProperty(value, Symbol.toPrimitive, { value: () => wire.display });
    Object.defineProperty(value, 'toString', { value: () => wire.display });
  }
  return value;
}
function pack(value) {
  if (value === undefined) return { kind: 'undefined' };
  const display = value && typeof value === 'object' && typeof value[Symbol.toPrimitive] === 'function'
    ? String(value) : undefined;
  return { kind: 'json', value, ...(display === undefined ? {} : { display }) };
}
function rpc(method, args) {
  const id = ++sequence;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    emit({ type: 'call', id, method, args });
  });
  const record = { promise, observed: false };
  issued.add(record);
  // Attach a rejection handler immediately even when generated code forgets await.
  promise.catch(() => {});
  return {
    then(yes, no) { record.observed = true; return promise.then(yes, no); },
    catch(no) { record.observed = true; return promise.catch(no); },
    finally(fn) { record.observed = true; return promise.finally(fn); },
  };
}
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', async line => {
  try {
    const message = JSON.parse(line);
    if (message.type === 'response') {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.ok) request.resolve(unpack(message.result));
      else request.reject(new Error(message.error));
      return;
    }
    if (message.type !== 'run' || started) throw new Error('invalid_guest_message');
    started = true;
    const namespaces = Object.create(null);
    for (const method of message.methods) {
      const [ns, member] = method.split('.');
      namespaces[ns] ||= Object.create(null);
      namespaces[ns][member] = (...args) => rpc(method, args);
    }
    const logs = [];
    const consoleProxy = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => {
      if (logs.length < 32) logs.push(args.map(String).join(' ').slice(0, 2000));
    }]));
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const execute = new AsyncFunction(...Object.keys(namespaces), 'console', '"use strict";\n' + message.code);
    const value = await execute(...Object.values(namespaces), consoleProxy);
    do { await Promise.allSettled([...issued].map(record => record.promise)); } while (pending.size);
    for (const record of issued) if (!record.observed) await record.promise;
    emit({ type: 'done', result: pack(value), logs });
  } catch (error) {
    emit({ type: 'error', error: String(error?.message || error).slice(0, 2000) });
  }
});
emit({ type: 'ready', uid: process.getuid(), pid: process.pid, noNewPrivs: true, seccomp: true });
`;
