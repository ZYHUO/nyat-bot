// Produce a standalone runtime lock from the already-reviewed repository lock.
// No registry lookup, version resolution, bot configuration or workspace copies.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, posix } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const root = JSON.parse(readFileSync(resolve(here, '../../package-lock.json'), 'utf8'));
const direct = ['@xenova/transformers', 'onnxruntime-node', 'lru-cache', 'zod'];
const dependencies = Object.fromEntries(direct.map(name => {
  const entry = root.packages[`node_modules/${name}`];
  if (!entry?.version || entry.link) throw new Error(`Missing locked runtime dependency: ${name}`);
  return [name, entry.version];
}));
const pkg = { name: 'nyat-embedding-compute', version: '1.0.0', private: true,
  type: 'module', engines: { node: '>=22.0.0 <23' }, dependencies };
const packages = { '': { name: pkg.name, version: pkg.version, engines: pkg.engines, dependencies } };
function locate(from, name) {
  let parent = from;
  while (true) {
    const key = posix.join(parent, 'node_modules', name);
    if (root.packages[key]) return key;
    if (!parent) return null;
    const next = posix.dirname(parent);
    parent = next === '.' ? '' : next;
  }
}
function visit(key) {
  if (packages[key]) return;
  const entry = root.packages[key];
  if (!entry || entry.link || !entry.integrity) throw new Error(`Unpinned runtime package: ${key}`);
  const copy = { ...entry };
  // These flags describe root-repo consumers, not this runtime-only closure.
  delete copy.dev; delete copy.devOptional; delete copy.optional;
  packages[key] = copy;
  const required = { ...entry.dependencies, ...entry.peerDependencies };
  for (const name of Object.keys({ ...required, ...entry.optionalDependencies })) {
    const found = locate(key, name);
    const optional = name in (entry.optionalDependencies ?? {}) || entry.peerDependenciesMeta?.[name]?.optional;
    if (!found && !optional) throw new Error(`Missing ${name} required by ${key}`);
    if (found) visit(found);
  }
}
for (const name of direct) visit(`node_modules/${name}`);
const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages };
writeFileSync(resolve(here, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
writeFileSync(resolve(here, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
console.log(JSON.stringify({ direct: dependencies, lockedPackages: Object.keys(packages).length - 1 }));
