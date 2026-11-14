/**
 * Resumable, destination-only memory migration. Never imports bot env or SQLite.
 * Node 22, local model cache by default. Existing .mts is a legacy migration with
 * different embedding input and FTS writes; do not interchange their checkpoints.
 *
 * Probe:    node scripts/reembed-memory.mjs --probe
 * Backfill: node scripts/reembed-memory.mjs --cache-dir=.benchmark-cache
 * Catch up: repeat the same command (same checkpoint; changed payloads are updated).
 * Finalize: stop ALL source writers, then add --finalize --source-paused.
 * Only after readyForCutover=true switch BOTH model and collection, then restart.
 * Keep the source collection for rollback. Do not run this after destination is live.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';

export const DEFAULTS = {
  endpoint: 'http://127.0.0.1:6333', source: 'xxb_group_history',
  destination: 'xxb_group_history_zh_20261114',
  model: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  inputMode: 'production-cache-key-v1', noTextPolicy: 'payload-only',
  dimensions: 384, batchSize: 64, sleepMs: 50, sampleSize: 5, embeddingCacheSize: 20000,
};

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new Error('Unsafe JSON number; refusing a lossy payload or ID migration');
  }
  return JSON.stringify(value);
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
const clone = (value) => JSON.parse(canonical(value));
const payloadOf = (point) => point.payload ?? {};
export function pointKey(id) {
  if (typeof id !== 'string' && !(typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)) throw new Error('Invalid or unsafe point ID');
  return `${typeof id}:${id}`;
}
export function embeddingText(payload) {
  return typeof payload?.text === 'string' && payload.text.trim() ? payload.text : null;
}
export function embeddingInput(text, mode = DEFAULTS.inputMode) {
  if (mode !== DEFAULTS.inputMode) throw new Error(`Unsupported runtime embedding input: ${mode}`);
  // Exact current src/memory/chroma.ts getEmbedder input, including UTF-16 length.
  return `${text.length}:${text.slice(0, 512)}`;
}

export function collectionSpec(info) {
  const config = info.config ?? {};
  const params = config.params ?? {};
  if (params.vectors?.size !== 384 || params.vectors?.distance !== 'Cosine') throw new Error('Expected the runtime single unnamed 384-dimension Cosine collection');
  if (params.sharding_method === 'custom' || Object.keys(params.sparse_vectors ?? {}).length) throw new Error('Custom shards or extra sparse vectors require a separate migration');
  const create = {};
  for (const key of ['vectors', 'shard_number', 'sharding_method', 'replication_factor', 'write_consistency_factor', 'on_disk_payload', 'payload', 'id_tracker']) {
    if (params[key] !== undefined && params[key] !== null) create[key] = clone(params[key]);
  }
  for (const key of ['hnsw_config', 'wal_config', 'quantization_config', 'strict_mode_config']) {
    if (config[key] !== undefined && config[key] !== null) create[key] = clone(config[key]);
  }
  if (config.optimizer_config) create.optimizers_config = clone(config.optimizer_config);
  const indexes = Object.entries(info.payload_schema ?? {}).map(([field, schema]) => ({
    field_name: field, field_schema: clone(schema.params ?? schema.data_type),
  })).sort((a, b) => a.field_name.localeCompare(b.field_name));
  return { create, indexes };
}

export function migrationIdentity(options) {
  return Object.fromEntries(['endpoint', 'source', 'destination', 'model', 'inputMode', 'noTextPolicy', 'dimensions'].map((key) => [key, options[key]]));
}
export function assertCheckpoint(checkpoint, identity, spec) {
  if (checkpoint.version !== 1 || canonical(checkpoint.identity) !== canonical(identity)) throw new Error('Checkpoint source/destination/model/input identity mismatch');
  if (checkpoint.sourceSpecHash !== hash(canonical(spec))) throw new Error('Source collection parameters/indexes changed; review before resuming');
}
export function atomicCheckpoint(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export async function retry(operation, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); } catch (error) {
      const status = error?.status ?? error?.statusCode;
      if (attempt >= attempts || (status && status < 500 && status !== 429)) throw error;
      await sleep(200 * 2 ** (attempt - 1));
    }
  }
}
function completed(result) {
  if (result?.status && result.status !== 'completed') throw new Error(`Qdrant write not completed: ${result.status}`);
}
const digestPoint = (digest, point) => hash(`${digest}\n${canonical({ id: point.id, payload: payloadOf(point) })}`);
function newPass(kind) {
  return { kind, offset: null, done: false, scanned: 0, written: 0, reused: 0, noText: 0, digest: hash(''), startedAt: new Date().toISOString() };
}
async function countExact(client, collection) {
  const result = await retry(() => client.count(collection, { exact: true }));
  if (!Number.isSafeInteger(result.count) || result.count < 0) throw new Error('Qdrant returned an invalid exact count');
  return result.count;
}
function denseVector(point) {
  return Array.isArray(point.vector) ? point.vector : point.vector?.[''];
}
function vectorValid(vector, dimensions) {
  return Array.isArray(vector) && vector.length === dimensions && vector.every(Number.isFinite) && vector.some((value) => value !== 0);
}

/** One model per wrapper; keys are the exact already-formatted model input. */
export function cacheEmbeddings(uncached, { maxEntries = 20000, dimensions = 384 } = {}) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new Error('Invalid embedding cache capacity');
  const cache = new Map();
  let hits = 0, misses = 0, evictions = 0;
  const embed = async (input) => {
    if (typeof input !== 'string') throw new Error('Embedding cache input must be a string');
    const cached = cache.get(input);
    if (cached) {
      hits++;
      cache.delete(input);
      cache.set(input, cached);
      return Array.from(cached); // A caller cannot mutate another point's cache entry.
    }
    misses++;
    const vector = await uncached(input);
    if (!vectorValid(vector, dimensions)) throw new Error('Invalid embedding; not cached');
    if (maxEntries > 0) {
      // Float64 preserves the exact Number values supplied by the model wrapper.
      // 20,000 x 384 x 8 bytes = 61.44 MB plus bounded input keys/Map overhead.
      cache.set(input, Float64Array.from(vector));
      if (cache.size > maxEntries) { cache.delete(cache.keys().next().value); evictions++; }
    }
    return vector;
  };
  embed.stats = () => ({ capacity: maxEntries, entries: cache.size, hits, misses, evictions });
  return embed;
}

export async function migratePass({ client, embed, options, checkpoint, save, log = () => {} }) {
  const pass = checkpoint.pass;
  let batches = 0;
  while (!pass.done) {
    const page = await retry(() => client.scroll(options.source, {
      limit: options.batchSize, ...(pass.offset === null ? {} : { offset: pass.offset }), with_payload: true, with_vector: false,
    }));
    const points = page.points ?? [];
    const nextOffset = page.next_page_offset ?? null;
    if (!points.length && nextOffset !== null) throw new Error('Empty source page with a nonterminal cursor');
    const existing = pass.kind === 'initial' || !points.length ? [] : await retry(() => client.retrieve(options.destination, {
      ids: points.map((point) => point.id), with_payload: true, with_vector: false,
    }));
    const byId = new Map(existing.map((point) => [pointKey(point.id), point]));
    const writes = [];
    let reused = 0, noText = 0;
    let digest = pass.digest;
    for (const point of points) {
      const key = pointKey(point.id);
      const payload = payloadOf(point);
      const serialized = canonical(payload); // Validate every field, not just text.
      const text = embeddingText(payload);
      if (text === null) noText++;
      const prior = byId.get(key);
      if (prior && canonical(payloadOf(prior)) === serialized) reused++;
      else {
        let vector = {};
        if (text !== null) {
          vector = await embed(embeddingInput(text, options.inputMode));
          if (!vectorValid(vector, options.dimensions)) throw new Error(`Invalid embedding for point ${key}`);
        }
        // Empty-vector points retain the complete payload/ID without mixing old
        // vectors into the new model space. Backend rejection halts migration.
        writes.push({ id: point.id, payload, vector });
      }
      digest = digestPoint(digest, point);
    }
    if (writes.length) completed(await retry(() => client.upsert(options.destination, { wait: true, points: writes })));
    // Commit the cursor only AFTER acknowledged destination writes. A crash before
    // this save simply repeats deterministic IDs, never skips an unfinished page.
    Object.assign(pass, {
      offset: nextOffset, done: nextOffset === null, scanned: pass.scanned + points.length,
      written: pass.written + writes.length, reused: pass.reused + reused, noText: pass.noText + noText, digest,
    });
    checkpoint.updatedAt = new Date().toISOString();
    await save(checkpoint);
    log({ event: 'page', pass: pass.kind, scanned: pass.scanned, written: pass.written, reused: pass.reused, noText: pass.noText, done: pass.done });
    batches++;
    if (options.maxBatches && batches >= options.maxBatches && !pass.done) return false;
    if (!pass.done && options.sleepMs) await sleep(options.sleepMs);
  }
  return true;
}

async function pruneDestination({ client, options, log }) {
  let offset = null, removed = 0;
  do {
    const page = await retry(() => client.scroll(options.destination, {
      limit: options.batchSize, ...(offset === null ? {} : { offset }), with_payload: false, with_vector: false,
    }));
    const ids = (page.points ?? []).map((point) => point.id);
    const source = ids.length ? await retry(() => client.retrieve(options.source, { ids, with_payload: false, with_vector: false })) : [];
    const live = new Set(source.map((point) => pointKey(point.id)));
    const absent = ids.filter((id) => !live.has(pointKey(id)));
    if (absent.length) completed(await retry(() => client.delete(options.destination, { wait: true, points: absent })));
    removed += absent.length;
    offset = page.next_page_offset ?? null;
  } while (offset !== null);
  log({ event: 'destination-orphans-removed', removed });
  return removed;
}

function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return dot / Math.sqrt(aa * bb);
}
export async function verifyDestination({ client, embed, options, expectedDigest }) {
  let offset = null, scanned = 0, noText = 0, digest = hash('');
  const samples = [];
  const sourceCountBefore = await countExact(client, options.source);
  do {
    const page = await retry(() => client.scroll(options.source, {
      limit: options.batchSize, ...(offset === null ? {} : { offset }), with_payload: true, with_vector: false,
    }));
    const points = page.points ?? [];
    const target = points.length ? await retry(() => client.retrieve(options.destination, {
      ids: points.map((point) => point.id), with_payload: true, with_vector: true,
    })) : [];
    const byId = new Map(target.map((point) => [pointKey(point.id), point]));
    for (const point of points) {
      const copy = byId.get(pointKey(point.id));
      if (!copy || canonical(payloadOf(copy)) !== canonical(payloadOf(point))) throw new Error(`Destination missing or changed payload: ${pointKey(point.id)}`);
      const text = embeddingText(payloadOf(point));
      const vector = denseVector(copy);
      if (text === null) {
        noText++;
        if (vector?.length || (!Array.isArray(copy.vector) && Object.keys(copy.vector ?? {}).length)) throw new Error(`No-text point still has a vector: ${pointKey(point.id)}`);
      } else {
        if (!vectorValid(vector, options.dimensions)) throw new Error(`Destination vector missing/invalid: ${pointKey(point.id)}`);
        if (samples.length < options.sampleSize) samples.push({ id: point.id, payload: payloadOf(point), vector });
      }
      digest = digestPoint(digest, point);
      scanned++;
    }
    offset = page.next_page_offset ?? null;
  } while (offset !== null);
  const sourceCountAfter = await countExact(client, options.source);
  const destinationCount = await countExact(client, options.destination);
  if (sourceCountBefore !== sourceCountAfter || scanned !== sourceCountAfter || destinationCount !== scanned || digest !== expectedDigest) {
    throw new Error('Final source changed or exact counts/digests differ; keep writers paused and rerun --finalize');
  }
  const sampleSearches = [];
  for (const sample of samples) {
    const input = embeddingInput(embeddingText(sample.payload), options.inputMode);
    const vector = await embed(input);
    const agreement = cosine(vector, sample.vector);
    if (!Number.isFinite(agreement) || agreement < 0.9999) throw new Error(`Sample embedding disagrees with migration model/input: ${pointKey(sample.id)}`);
    const results = await retry(() => client.search(options.destination, {
      vector, limit: 5, with_payload: false,
      ...(typeof sample.payload.chatId === 'number' ? { filter: { must: [{ key: 'chatId', match: { value: sample.payload.chatId } }] } } : {}),
      params: { exact: true },
    }));
    sampleSearches.push({ pointId: sample.id, inputSha256: hash(input), vectorCosine: agreement, hits: results.map((hit) => ({ id: hit.id, score: hit.score })) });
  }
  return { sourceCountBefore, sourceCountAfter, destinationCount, scanned, withText: scanned - noText, noText, payloadAndIdSha256: digest, vectorsChecked: scanned - noText, sampleSearches };
}

export async function runMigration({ client, embed, options: overrides, checkpoint = null, save, log = () => {} }) {
  const options = { ...DEFAULTS, ...overrides };
  if (options.source === options.destination) throw new Error('Source and destination must be different actual collections');
  if (options.noTextPolicy !== 'payload-only') throw new Error('Only payload-preserving no-text handling is supported');
  if (options.finalize && !options.sourcePaused) throw new Error('--finalize requires --source-paused after stopping all source writers');
  const sourceInfo = await retry(() => client.getCollection(options.source));
  const spec = collectionSpec(sourceInfo);
  const identity = migrationIdentity(options);
  const collections = await retry(() => client.getCollections());
  if (!collections.collections.some((item) => item.name === options.source)) throw new Error('Source must be an actual collection, not an alias');
  const exists = collections.collections.some((item) => item.name === options.destination);
  if (!checkpoint) {
    if (exists) throw new Error('Destination exists without its migration checkpoint; refusing unknown model provenance');
    checkpoint = { version: 1, identity, sourceSpecHash: hash(canonical(spec)), sourceSpec: spec, status: 'running', createdAt: new Date().toISOString(), passes: [], pass: newPass('initial') };
    await save(checkpoint); // Bind identity before the first destination mutation.
  } else assertCheckpoint(checkpoint, identity, spec);
  if (!exists) {
    if (checkpoint.pass.scanned > 0 || checkpoint.passes.length) throw new Error('Checkpoint has progress but destination disappeared');
    await retry(() => client.createCollection(options.destination, spec.create));
  }
  const targetSpec = collectionSpec(await retry(() => client.getCollection(options.destination)));
  if (canonical(targetSpec.create) !== canonical(spec.create)) throw new Error('Destination collection configuration differs from source');
  for (const index of spec.indexes) {
    const present = targetSpec.indexes.find((item) => item.field_name === index.field_name);
    if (present && canonical(present) !== canonical(index)) throw new Error(`Destination index schema differs: ${index.field_name}`);
    if (!present) completed(await retry(() => client.createPayloadIndex(options.destination, { ...index, wait: true })));
  }
  if (checkpoint.status === 'validated' && !options.finalize && !options.catchUp) return checkpoint.report;
  if (options.finalize && checkpoint.pass.kind !== 'finalize') {
    if (checkpoint.pass.scanned) checkpoint.passes.push(checkpoint.pass);
    checkpoint.pass = newPass('finalize');
  } else if (checkpoint.pass.done) {
    checkpoint.passes.push(checkpoint.pass);
    checkpoint.pass = newPass(options.finalize ? 'finalize' : 'catchup');
  }
  checkpoint.status = 'running';
  delete checkpoint.report; // Never expose a previous successful report during a new pass.
  await save(checkpoint);
  const firstCompleted = await migratePass({ client, embed, options, checkpoint, save, log });
  if (!firstCompleted) return { readyForCutover: false, status: 'partial', pass: checkpoint.pass };
  // The first online pass is followed by a second full ID/payload comparison.
  // UUID order cannot detect inserts before a previous cursor without this pass.
  if (checkpoint.pass.kind === 'initial' && !options.finalize) {
    checkpoint.passes.push(checkpoint.pass);
    checkpoint.pass = newPass('catchup');
    await save(checkpoint);
    if (!await migratePass({ client, embed, options, checkpoint, save, log })) return { readyForCutover: false, status: 'partial', pass: checkpoint.pass };
  }
  const report = {
    identity, readyForCutover: false, status: 'caught_up',
    sourceExactCount: await countExact(client, options.source), destinationExactCount: await countExact(client, options.destination),
    pass: clone(checkpoint.pass),
  };
  if (options.finalize) {
    report.removedDestinationOrphans = await pruneDestination({ client, options, log });
    report.verification = await verifyDestination({ client, embed, options, expectedDigest: checkpoint.pass.digest });
    report.sourceExactCount = report.verification.sourceCountAfter;
    report.destinationExactCount = report.verification.destinationCount;
    report.operatorConfirmedSourcePaused = true;
    report.readyForCutover = true;
    report.status = 'validated';
  }
  checkpoint.status = report.status;
  checkpoint.report = report;
  await save(checkpoint);
  return report;
}

async function probe(client, options) {
  const info = await client.getCollection(options.source);
  const spec = collectionSpec(info);
  const page = await client.scroll(options.source, { limit: 64, with_payload: true, with_vector: false });
  return {
    source: options.source, exactCount: await countExact(client, options.source), spec,
    textField: 'payload.text', inputMode: options.inputMode, noTextPolicy: options.noTextPolicy,
    sample: page.points.map((point) => ({ id: point.id, payloadKeys: Object.keys(payloadOf(point)).sort(), textType: typeof payloadOf(point).text, textLength: embeddingText(payloadOf(point))?.length ?? 0 })),
    note: 'Read-only sample; exact no-text count is measured during full migration. No alternate field is guessed and no message text is printed.',
  };
}
function acquireLock(path) {
  if (existsSync(path)) {
    const prior = JSON.parse(readFileSync(path, 'utf8'));
    let alive = true;
    if (prior.host === hostname()) {
      try { process.kill(prior.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    }
    if (alive) throw new Error(`Migration lock is held by ${prior.host}:${prior.pid}`);
    unlinkSync(path);
  }
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid, host: hostname() }));
  closeSync(fd);
  return () => unlinkSync(path);
}
export function validateArguments(argv) {
  const flags = new Set(['help', 'probe', 'catch-up', 'finalize', 'source-paused', 'allow-download']);
  const values = new Set(['url', 'source', 'destination', 'model', 'input-mode', 'batch', 'sleep', 'max-batches', 'cache-dir', 'checkpoint', 'embed-cache']);
  const seen = new Set();
  for (const argument of argv) {
    const match = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(argument);
    if (!match) throw new Error(`Invalid argument ${argument}; use --help`);
    const [, name, value] = match;
    if (!flags.has(name) && !values.has(name)) throw new Error(`Unknown option --${name}; use --url=http://HOST:PORT for the Qdrant address`);
    if (seen.has(name)) throw new Error(`Duplicate option --${name}`);
    seen.add(name);
    if (flags.has(name) && value !== undefined) throw new Error(`--${name} takes no value`);
    if (values.has(name) && (value === undefined || value === '')) throw new Error(`--${name} requires --${name}=VALUE`);
  }
}
export async function main(argv = process.argv.slice(2)) {
  validateArguments(argv); // Fail before connecting to any endpoint or touching files.
  const get = (name, fallback) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const has = (name) => argv.includes(`--${name}`);
  if (has('help')) {
    console.log('node scripts/reembed-memory.mjs [--url=http://127.0.0.1:6333] [--probe] [--cache-dir=PATH] [--checkpoint=PATH] [--source=NAME] [--destination=NAME] [--model=MODEL] [--input-mode=production-cache-key-v1] [--allow-download] [--embed-cache=20000] [--batch=64] [--sleep=50] [--max-batches=1] [--catch-up] [--finalize --source-paused]');
    return;
  }
  const options = {
    ...DEFAULTS, endpoint: get('url', DEFAULTS.endpoint), source: get('source', DEFAULTS.source), destination: get('destination', DEFAULTS.destination),
    model: get('model', DEFAULTS.model), inputMode: get('input-mode', DEFAULTS.inputMode),
    batchSize: Number(get('batch', '64')), sleepMs: Number(get('sleep', '50')), maxBatches: Number(get('max-batches', '0')),
    embeddingCacheSize: Number(get('embed-cache', String(DEFAULTS.embeddingCacheSize))),
    finalize: has('finalize'), sourcePaused: has('source-paused'), catchUp: has('catch-up'),
  };
  for (const [key, minimum] of [['batchSize', 1], ['sleepMs', 0], ['maxBatches', 0], ['embeddingCacheSize', 0]]) {
    if (!Number.isSafeInteger(options[key]) || options[key] < minimum) throw new Error(`Invalid ${key}`);
  }
  embeddingInput('', options.inputMode);
  if (options.source === options.destination) throw new Error('Source and destination must differ');
  if (options.finalize && !options.sourcePaused) throw new Error('--finalize requires --source-paused');
  const { QdrantClient } = await import('@qdrant/js-client-rest');
  const client = new QdrantClient({ url: options.endpoint, timeout: 120_000 });
  if (has('probe')) { console.log(JSON.stringify(await probe(client, options), null, 2)); return; }
  const checkpointPath = resolve(get('checkpoint', `.migration/${options.destination}.checkpoint.json`));
  const release = acquireLock(`${checkpointPath}.lock`);
  let extractor;
  try {
    const checkpoint = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, 'utf8')) : null;
    if (checkpoint && canonical(checkpoint.identity) !== canonical(migrationIdentity(options))) throw new Error('Checkpoint identity mismatch');
    const { pipeline, env } = await import('@xenova/transformers');
    env.cacheDir = resolve(get('cache-dir', '.benchmark-cache'));
    env.allowRemoteModels = has('allow-download');
    extractor = await pipeline('feature-extraction', options.model, { quantized: true, local_files_only: !has('allow-download') });
    const embed = cacheEmbeddings(async (input) => Array.from((await extractor(input, { pooling: 'mean', normalize: true })).data), {
      maxEntries: options.embeddingCacheSize, dimensions: options.dimensions,
    });
    const probeVector = await embed(embeddingInput('中文模型维度自检', options.inputMode));
    if (!vectorValid(probeVector, options.dimensions)) throw new Error('Model dimension/self-test failed');
    const report = await runMigration({
      client, embed, options, checkpoint, save: (value) => atomicCheckpoint(checkpointPath, value),
      log: (event) => process.stderr.write(`${JSON.stringify({ ...event, embeddingCache: embed.stats() })}\n`),
    });
    console.log(JSON.stringify({ ...report, embeddingCache: embed.stats() }, null, 2));
  } finally {
    try { if (extractor) await extractor.dispose(); } finally { release(); }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
