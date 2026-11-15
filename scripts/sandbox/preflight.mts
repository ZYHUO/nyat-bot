import { readFile } from 'node:fs/promises';
import { preflightCodeActIsolation } from '../../src/sandbox/codeact/runner.js';
import type { CodeActProfile } from '../../src/sandbox/codeact/profile.js';

const path = process.argv[2];
if (!path) throw new Error('Usage: node --import tsx scripts/sandbox/preflight.mts PROFILE.json');
const profile = JSON.parse(await readFile(path, 'utf8')) as CodeActProfile;
const result = await preflightCodeActIsolation(profile);
console.log(JSON.stringify(result));
if (!result.available) process.exitCode = 1;
