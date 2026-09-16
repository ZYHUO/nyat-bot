import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAcceptance } from '../../../src/agent/task-evidence.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'nyat-accept-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('host artifact acceptance', () => {
  it('does not certify absent, empty, or model-authored acceptance', async () => {
    expect((await validateAcceptance(root)).status).toBe('unverified');
    expect((await validateAcceptance(root, { source: 'caller', checks: [] })).status).toBe('unverified');
    await writeFile(join(root, 'x'), 'real');
    expect((await validateAcceptance(root, { source: 'model', checks: [{ kind: 'nonempty_file', path: 'x' }] })).status).toBe('unverified');
  });
  it('independently checks JSON and refuses incorrect values', async () => {
    await writeFile(join(root, 'x'), '{"a":42}');
    expect((await validateAcceptance(root, { source: 'caller', checks: [{ kind: 'json_field', path: 'x', field: ['a'], equals: 42 }] })).status).toBe('verified');
    expect((await validateAcceptance(root, { source: 'caller', checks: [{ kind: 'json_field', path: 'x', field: ['a'], equals: 0 }] })).status).toBe('failed');
  });
  it('rejects escapes, symlinks, malformed checks, large files and special files', async () => {
    await symlink('/etc/passwd', join(root, 'link'));
    await writeFile(join(root, 'large'), Buffer.alloc(1024 * 1024 + 1));
    for (const path of ['../etc/passwd', '/etc/passwd', 'link', 'large', '.']) {
      expect((await validateAcceptance(root, { source: 'caller', checks: [{ kind: 'nonempty_file', path }] })).status).toBe('failed');
    }
    expect((await validateAcceptance(root, { source: 'caller', checks: [{ kind: 'exec', path: 'x' }] } as never)).status).toBe('failed');
  });
});
