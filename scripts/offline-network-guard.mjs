/** Offline smoke boundary. A mock may replace fetch; an actual socket still fails. */
import net from 'node:net';
import dgram from 'node:dgram';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

if (process.env.NYATBOT_OFFLINE_INTEGRATION === '1') {
  const audit = process.env.NYATBOT_OFFLINE_AUDIT;
  if (!audit) throw new Error('offline_audit_required');
  appendFileSync(audit, JSON.stringify({ kind: 'guard_loaded', pid: process.pid }) + '\n', { mode: 0o600 });
  const reject = () => {
    // No addresses, request data, keys, URLs or chat bodies in the audit.
    const frames = (new Error().stack ?? '').split('\n').map(line => line.replaceAll('\\', '/'));
    const origin = frames.map(line => line.match(/(?:\/)(src|tests|node_modules)\/[^\s)]+/)?.[0]).filter(Boolean).slice(0, 3);
    appendFileSync(audit, JSON.stringify({ kind: 'network_denied', pid: process.pid, origin }) + '\n');
    throw new Error('OFFLINE_INTEGRATION_NETWORK_DENIED');
  };
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const ipc = typeof first === 'string' && !/^\d+$/.test(first)
      || first && typeof first === 'object' && typeof first.path === 'string';
    if (ipc) {
      // tsx optionally probes its parent's local telemetry pipe. Decline it
      // without opening any IPC endpoint, allowing its normal error fallback.
      appendFileSync(audit, JSON.stringify({ kind: 'ipc_blocked', pid: process.pid }) + '\n');
      process.nextTick(() => this.emit('error', Object.assign(new Error('offline_ipc_disabled'), { code: 'ECONNREFUSED' })));
      return this;
    }
    return reject();
  };
  dgram.Socket.prototype.send = reject;
}
