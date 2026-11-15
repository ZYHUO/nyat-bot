import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export function shutdownCheckpointPath(sqlitePath: string): string {
  return join(dirname(resolve(sqlitePath)), 'shutdown-checkpoints', `${process.pid}.json`);
}

export function clearShutdownCheckpoint(sqlitePath: string): void {
  mkdirSync(dirname(shutdownCheckpointPath(sqlitePath)), { recursive: true, mode: 0o700 });
  rmSync(shutdownCheckpointPath(sqlitePath), { force: true });
}

/** Written only after all application writers have joined and stores closed. */
export function writeShutdownCheckpoint(sqlitePath: string, processStartedAt: number): void {
  const target = shutdownCheckpointPath(sqlitePath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, clean: true, pid: process.pid,
    processStartedAt, completedAt: Date.now(), storesClosed: ['sqlite', 'nyatdb', 'redis'] }) + '\n', { mode: 0o600 });
  renameSync(temp, target);
}
