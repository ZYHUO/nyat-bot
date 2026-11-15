import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { stopEmbeddingServer } from '../../../src/compute/shutdown.js';

afterEach(() => vi.useRealTimers());
describe('independent embedding runtime packaging and shutdown', () => {
  it('pins every runtime package to the reviewed root lock, without bot dependencies', () => {
    const root = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const runtime = JSON.parse(readFileSync('ops/embedding/package-lock.json', 'utf8'));
    const pkg = JSON.parse(readFileSync('ops/embedding/package.json', 'utf8'));
    expect(pkg.dependencies).toEqual({ '@xenova/transformers': '2.17.2', 'onnxruntime-node': '1.14.0', 'lru-cache': '11.3.3', zod: '3.25.76' });
    expect(runtime.packages[''].dependencies).toEqual(pkg.dependencies);
    for (const [path, entry] of Object.entries(runtime.packages)) {
      if (!path) continue;
      const locked = entry as { version: string; integrity: string; resolved: string };
      expect(locked.integrity).toBe(root.packages[path].integrity);
      expect(locked.version).toBe(root.packages[path].version);
      expect(locked.resolved).toBe(root.packages[path].resolved);
    }
    expect(runtime.packages).not.toHaveProperty('node_modules/grammy');
    expect(runtime.packages).not.toHaveProperty('node_modules/better-sqlite3');
    expect(runtime.packages).not.toHaveProperty('node_modules/ioredis');
  });
  it('exits when HTTP closes even if a native worker keeps the process alive', () => {
    vi.useFakeTimers(); const exit = vi.fn(); let close: () => void = () => {};
    const server = { close: vi.fn((cb: () => void) => { close = cb; }), closeIdleConnections: vi.fn(), closeAllConnections: vi.fn() };
    stopEmbeddingServer(server as unknown as Server, { exit, timeoutMs: 100 });
    expect(exit).not.toHaveBeenCalled(); close();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    vi.advanceTimersByTime(101); expect(exit).toHaveBeenCalledTimes(1);
  });
  it('terminates by deadline if an active connection/native request never finishes', () => {
    vi.useFakeTimers(); const exit = vi.fn();
    const server = { close: vi.fn(), closeIdleConnections: vi.fn(), closeAllConnections: vi.fn() };
    stopEmbeddingServer(server as unknown as Server, { exit, timeoutMs: 100 });
    vi.advanceTimersByTime(100);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
