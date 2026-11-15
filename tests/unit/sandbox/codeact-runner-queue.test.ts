import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCodeActSandbox } from '../../../src/sandbox/codeact/runner.js';
import type { CodeActRunOptions } from '../../../src/sandbox/codeact/runner.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), validate: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../../../src/env.js', () => ({ env: () => ({ CODEACT_ISOLATION_ENABLED: false }) }));
vi.mock('../../../src/sandbox/codeact/profile.js', () => ({
  validateCodeActProfile: mocks.validate,
  codeActLaunchArgs: () => [],
}));

const profile = { bwrapPath: '/test/bwrap', prlimitPath: '/test/prlimit', nodePath: '/test/node', runtimeFiles: ['/test/libc.so.6'] };
class Guest extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly filter = new PassThrough();
  readonly stdin = new Writable({ write: (chunk, _encoding, done) => {
    const message = JSON.parse(String(chunk)) as { type: string; code?: string };
    if (message.type === 'run') this.code = message.code;
    done();
  } });
  readonly stdio = [this.stdin, this.stdout, this.stderr, this.filter];
  code: string | undefined;
  // No real PID: these tests exercise the runner's actual queue/RPC state machine,
  // with only the OS process boundary and trusted profile IO substituted.
  pid: number | undefined;
  exitCode = null;
  signalCode = null;
  kill = vi.fn();
  frame(value: object): void { this.stdout.write(JSON.stringify(value) + '\n'); }
  ready(): void { this.frame({ type: 'ready', uid: 65534, noNewPrivs: true, seccomp: true }); }
  done(value = this.code): void { this.frame({ type: 'done', result: { kind: 'json', value }, logs: [] }); }
}
const guests: Guest[] = [];
const action = vi.fn();
function run(code: string, options: Partial<CodeActRunOptions> = {}) {
  return runCodeActSandbox(profile, code, new Map([['test.action', action]]), {
    timeoutMs: 1000, ...options,
  }).then(
    result => ({ ok: true as const, result }),
    error => ({ ok: false as const, error: String((error as Error).message) }),
  );
}
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  guests.length = 0;
  action.mockReset();
  mocks.validate.mockReset().mockResolvedValue(undefined);
  mocks.spawn.mockReset().mockImplementation(() => {
    const guest = new Guest();
    guests.push(guest);
    queueMicrotask(() => guest.ready());
    return guest;
  });
});
afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('CodeAct runner shared FIFO', () => {
  it('serializes concurrent Meta and worker calls in arrival order and executes RPC only for the active guest', async () => {
    const first = run('meta');
    const second = run('chat-a');
    const third = run('chat-b');
    await flush();
    expect(guests.map(guest => guest.code)).toEqual(['meta']);
    guests[0]!.frame({ type: 'call', id: 1, method: 'test.action', args: ['meta'] });
    await flush();
    expect(action).toHaveBeenCalledExactlyOnceWith('meta');
    guests[0]!.done();
    expect((await first).ok).toBe(true);
    await flush();
    expect(guests.map(guest => guest.code)).toEqual(['meta', 'chat-a']);
    guests[1]!.done();
    expect((await second).ok).toBe(true);
    await flush();
    expect(guests.map(guest => guest.code)).toEqual(['meta', 'chat-a', 'chat-b']);
    guests[2]!.done();
    expect((await third).ok).toBe(true);
  });

  it('expires a queued request without validating, launching, or invoking its capabilities', async () => {
    const first = run('hold');
    const onTimeout = vi.fn();
    const expired = run('must-not-run', { timeoutMs: 40, onTimeout });
    await vi.advanceTimersByTimeAsync(40);
    expect(await expired).toEqual({ ok: false, error: 'codeact_timeout' });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.validate).toHaveBeenCalledTimes(1);
    expect(action).not.toHaveBeenCalled();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    guests[0]!.done();
    await first;
  });

  it('counts queue waiting time against the running guest deadline', async () => {
    const first = run('hold');
    const onTimeout = vi.fn();
    const second = run('only-20ms-left', { timeoutMs: 100, onTimeout });
    await vi.advanceTimersByTimeAsync(80);
    guests[0]!.done();
    await first;
    await flush();
    expect(guests[1]?.code).toBe('only-20ms-left');
    await vi.advanceTimersByTimeAsync(20);
    expect(await second).toEqual({ ok: false, error: 'codeact_timeout' });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    guests[1]!.frame({ type: 'call', id: 1, method: 'test.action', args: [] });
    await flush();
    expect(action).not.toHaveBeenCalled();
  });

  it('removes a cancelled waiter while preserving later FIFO work', async () => {
    let cancelled = false;
    const first = run('hold');
    const second = run('cancelled', { isClosed: () => cancelled });
    const third = run('survivor');
    await flush();
    cancelled = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(await second).toEqual({ ok: false, error: 'codeact_cancelled' });
    guests[0]!.done();
    await first;
    await flush();
    expect(guests.map(guest => guest.code)).toEqual(['hold', 'survivor']);
    guests[1]!.done();
    expect((await third).ok).toBe(true);
    expect(action).not.toHaveBeenCalled();
  });

  it('rechecks cancellation when acquiring the slot before the poll timer fires', async () => {
    let cancelled = false;
    const first = run('hold');
    const second = run('cancelled', { isClosed: () => cancelled });
    await flush();
    cancelled = true;
    guests[0]!.done();
    await first;
    expect(await second).toEqual({ ok: false, error: 'codeact_cancelled' });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('bounds the queue, then recovers capacity after cancellation', async () => {
    let cancelled = false;
    const first = run('hold');
    const waiting = Array.from({ length: 16 }, (_, index) => run(`waiting-${index}`, { isClosed: () => cancelled }));
    expect(await run('overflow')).toEqual({ ok: false, error: 'codeact_isolation_queue_full' });
    cancelled = true;
    await vi.advanceTimersByTimeAsync(50);
    expect((await Promise.all(waiting)).every(result => !result.ok && result.error === 'codeact_cancelled')).toBe(true);
    const next = run('recovered');
    guests[0]!.done();
    await first;
    await flush();
    expect(guests[1]?.code).toBe('recovered');
    guests[1]!.done();
    expect((await next).ok).toBe(true);
  });

  it('does not launch code after timed-out profile validation eventually resolves', async () => {
    let resolveValidation: (() => void) | undefined;
    mocks.validate.mockImplementationOnce(() => new Promise<void>(resolve => { resolveValidation = resolve; }));
    const onTimeout = vi.fn();
    const first = run('late-profile', { timeoutMs: 40, onTimeout });
    const second = run('next');
    await vi.advanceTimersByTimeAsync(40);
    expect(await first).toEqual({ ok: false, error: 'codeact_timeout' });
    expect(guests.map(guest => guest.code)).toEqual(['next']);
    resolveValidation!();
    await flush();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    guests[0]!.done();
    await second;
  });

  it('cancels active execution, ignores its late RPC and releases the next request', async () => {
    let cancelled = false;
    const first = run('cancel-active', { isClosed: () => cancelled });
    const second = run('next');
    await flush();
    cancelled = true;
    await vi.advanceTimersByTimeAsync(50);
    expect(await first).toEqual({ ok: false, error: 'codeact_cancelled' });
    guests[0]!.frame({ type: 'call', id: 1, method: 'test.action', args: [] });
    await flush();
    expect(action).not.toHaveBeenCalled();
    expect(guests[1]?.code).toBe('next');
    guests[1]!.done();
    await second;
  });

  it('releases the slot after profile failure and after process startup failure', async () => {
    mocks.validate.mockRejectedValueOnce(new Error('invalid profile'));
    const first = run('invalid');
    const second = run('spawn-fails');
    const third = run('healthy');
    expect(await first).toEqual({ ok: false, error: 'invalid profile' });
    await flush();
    guests[0]!.emit('error', new Error('spawn failed'));
    expect(await second).toEqual({ ok: false, error: 'codeact_isolation_unavailable: spawn failed' });
    await flush();
    expect(guests[1]?.code).toBe('healthy');
    guests[1]!.done();
    await third;
  });

  it('waits for close acknowledgement after SIGKILL before starting the next guest', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const first = run('first');
    const second = run('second');
    await flush();
    guests[0]!.pid = 900001;
    guests[0]!.done();
    await flush();
    expect(kill).toHaveBeenCalledWith(-900001, 'SIGKILL');
    expect(guests).toHaveLength(1);
    guests[0]!.emit('close', null, 'SIGKILL');
    expect((await first).ok).toBe(true);
    await flush();
    expect(guests[1]?.code).toBe('second');
    guests[1]!.done();
    await second;
  });

  it('bounds unconfirmed teardown and refuses further guests until process restart', async () => {
    // Isolate the deliberate permanent failure latch from other tests/modules.
    vi.resetModules();
    const { runCodeActSandbox: isolatedRun } = await import('../../../src/sandbox/codeact/runner.js');
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const attempt = (code: string) => isolatedRun(profile, code, new Map([['test.action', action]]), { timeoutMs: 5000 })
      .then(() => 'ok', error => String((error as Error).message));
    const first = attempt('unconfirmed');
    const second = attempt('must-not-start');
    await flush();
    guests[0]!.pid = 900002;
    guests[0]!.done();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBe('codeact_isolation_teardown_unconfirmed');
    expect(await second).toBe('codeact_isolation_teardown_unconfirmed');
    expect(await attempt('later')).toBe('codeact_isolation_teardown_unconfirmed');
    expect(guests).toHaveLength(1);
    expect(action).not.toHaveBeenCalled();
    guests[0]!.emit('close', null, 'SIGKILL');
    expect(await attempt('even-after-late-close')).toBe('codeact_isolation_teardown_unconfirmed');
  });
});
