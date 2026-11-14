import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DEFAULTS, canonical, collectionSpec, embeddingInput, embeddingText, pointKey, runMigration, validateArguments, cacheEmbeddings,
} from '../../scripts/reembed-memory.mjs';

const copy = (value) => structuredClone(value);
const sourceConfig = {
  params: { vectors: { size: 384, distance: 'Cosine', on_disk: true }, shard_number: 1, replication_factor: 1, write_consistency_factor: 1, on_disk_payload: true },
  hnsw_config: { m: 16, ef_construct: 100, full_scan_threshold: 10000, max_indexing_threads: 0 },
  optimizer_config: { default_segment_number: 0, flush_interval_sec: 5, indexing_threshold: 20000 },
  wal_config: { wal_capacity_mb: 32, wal_segments_ahead: 0 },
  quantization_config: { scalar: { type: 'int8', quantile: 0.99, always_ram: true } },
};
const sourceIndexes = {
  chatId: { data_type: 'integer', points: 5 },
  text: { data_type: 'text', params: { type: 'text', tokenizer: 'word', lowercase: true }, points: 5 },
};
const point = (id, text = '中文记忆', fields = {}) => ({ id, payload: { text, chatId: -100, uid: 42, nested: { keep: ['原值', 3] }, ...fields } });
async function embed(input) {
  const digest = createHash('sha256').update(input).digest();
  const result = new Array(384).fill(0);
  for (let i = 0; i < 32; i++) result[i] = digest[i] + 1;
  const norm = Math.sqrt(result.reduce((sum, value) => sum + value * value, 0));
  return result.map((value) => value / norm);
}
class FakeQdrant {
  constructor(points) {
    this.collections = new Map([[DEFAULTS.source, { points: new Map(points.map((p) => [pointKey(p.id), copy(p)])), config: copy(sourceConfig), payload_schema: copy(sourceIndexes) }]]);
    this.mutations = [];
    this.onScroll = null;
  }
  row(name) { assert.ok(this.collections.has(name)); return this.collections.get(name); }
  async getCollections() { return { collections: [...this.collections.keys()].map((name) => ({ name })) }; }
  async getCollection(name) { const row = this.row(name); return copy({ config: row.config, payload_schema: row.payload_schema, points_count: row.points.size }); }
  async count(name) { return { count: this.row(name).points.size }; }
  async createCollection(name, spec) {
    assert.notEqual(name, DEFAULTS.source);
    const params = Object.fromEntries(['vectors', 'shard_number', 'replication_factor', 'write_consistency_factor', 'on_disk_payload'].map((key) => [key, spec[key]]));
    this.collections.set(name, { points: new Map(), payload_schema: {}, config: { params, hnsw_config: copy(spec.hnsw_config), optimizer_config: copy(spec.optimizers_config), wal_config: copy(spec.wal_config), quantization_config: copy(spec.quantization_config) } });
    this.mutations.push(['create', name]);
    return true;
  }
  async createPayloadIndex(name, index) {
    this.row(name).payload_schema[index.field_name] = typeof index.field_schema === 'string'
      ? { data_type: index.field_schema, points: 0 }
      : { data_type: index.field_schema.type, params: copy(index.field_schema), points: 0 };
    this.mutations.push(['index', name]);
    return { status: 'completed' };
  }
  async scroll(name, options) {
    if (this.onScroll) await this.onScroll(name, options);
    const sorted = [...this.row(name).points.values()].sort((a, b) => pointKey(a.id).localeCompare(pointKey(b.id)));
    const start = options.offset === undefined ? 0 : sorted.findIndex((p) => pointKey(p.id) >= pointKey(options.offset));
    const page = start === -1 ? [] : sorted.slice(start, start + options.limit);
    const next = start === -1 ? undefined : sorted[start + options.limit];
    return { points: page.map((p) => this.project(p, options)), next_page_offset: next?.id ?? null };
  }
  project(point, options) {
    const result = { id: point.id };
    if (options.with_payload) result.payload = copy(point.payload ?? {});
    if (options.with_vector) result.vector = copy(point.vector ?? {});
    return result;
  }
  async retrieve(name, options) {
    return options.ids.map((id) => this.row(name).points.get(pointKey(id))).filter(Boolean).map((p) => this.project(p, options));
  }
  async upsert(name, options) {
    assert.notEqual(name, DEFAULTS.source);
    assert.equal(options.wait, true);
    for (const point of options.points) this.row(name).points.set(pointKey(point.id), copy(point));
    this.mutations.push(['upsert', name, options.points.map((p) => p.id)]);
    return { status: 'completed' };
  }
  async delete(name, options) {
    assert.notEqual(name, DEFAULTS.source);
    for (const id of options.points) this.row(name).points.delete(pointKey(id));
    this.mutations.push(['delete', name, options.points]);
    return { status: 'completed' };
  }
  async search(name, options) {
    return [...this.row(name).points.values()].filter((p) => Array.isArray(p.vector)).slice(0, options.limit).map((p) => ({ id: p.id, score: 1 }));
  }
}
function harness(points) {
  const client = new FakeQdrant(points);
  let checkpoint = null;
  return {
    client,
    get checkpoint() { return copy(checkpoint); },
    save(value) { checkpoint = copy(value); },
    async run(options = {}, extra = {}) {
      return runMigration({ client, embed, options: { ...DEFAULTS, sleepMs: 0, batchSize: 2, ...options }, checkpoint: copy(checkpoint), save: (value) => { checkpoint = copy(value); }, ...extra });
    },
  };
}

test('runtime input includes original UTF-16 length and truncates only after the prefix', () => {
  const text = '猫😀'.repeat(300);
  assert.equal(embeddingInput(text), `${text.length}:${text.slice(0, 512)}`);
  assert.equal(embeddingText({ text: '  ' }), null);
  assert.equal(embeddingText({ document: 'not a supported field' }), null);
  assert.throws(() => embeddingInput('中文', 'raw'));
});

test('CLI rejects unknown, duplicate and malformed options before any endpoint is used', () => {
  assert.doesNotThrow(() => validateArguments(['--url=http://127.0.0.1:16333', '--probe']));
  assert.throws(() => validateArguments(['--endpoint=http://127.0.0.1:16333']), /Unknown option --endpoint/);
  assert.throws(() => validateArguments(['--url=one', '--url=two']), /Duplicate/);
  assert.throws(() => validateArguments(['--url']), /requires/);
  assert.throws(() => validateArguments(['--url=']), /requires/);
  assert.throws(() => validateArguments(['--probe=false']), /takes no value/);
  assert.throws(() => validateArguments(['somewhere']), /Invalid argument/);
});

test('embedding cache reuses exact processed inputs and isolates returned vectors from mutation', async () => {
  let calls = 0;
  const cached = cacheEmbeddings(async (input) => { calls++; return embed(input); }, { maxEntries: 2 });
  const input = embeddingInput('完全相同的中文');
  const first = await cached(input);
  const expected = [...first];
  first[0] = -999;
  const second = await cached(input);
  assert.deepEqual(second, expected);
  second[1] = -888;
  assert.deepEqual(await cached(input), expected);
  await cached(embeddingInput('另一段中文'));
  assert.equal(calls, 2);
  assert.equal(cached.stats().hits, 2);
});

test('bounded LRU evicts the least recently used input and capacity zero disables storage', async () => {
  let calls = 0;
  const cached = cacheEmbeddings(async (input) => { calls++; return embed(input); }, { maxEntries: 2 });
  await cached('a'); await cached('b'); await cached('a'); await cached('c'); await cached('b');
  assert.equal(calls, 4);
  assert.deepEqual(cached.stats(), { capacity: 2, entries: 2, hits: 1, misses: 4, evictions: 2 });
  const disabled = cacheEmbeddings(embed, { maxEntries: 0 });
  await disabled('a'); await disabled('a');
  assert.equal(disabled.stats().entries, 0);
  assert.equal(disabled.stats().hits, 0);
});

test('failed or invalid vectors are never cached', async () => {
  let calls = 0;
  const cached = cacheEmbeddings(async (input) => {
    calls++;
    if (calls === 1) throw new Error('transient inference failure');
    if (calls === 2) return new Array(384).fill(Number.NaN);
    return embed(input);
  });
  await assert.rejects(cached('same'), /transient/);
  await assert.rejects(cached('same'), /not cached/);
  const successful = await cached('same');
  assert.deepEqual(await cached('same'), successful);
  assert.equal(calls, 3);
  assert.equal(cached.stats().entries, 1);
});

test('cache reduces repeated-text inference without changing point IDs, payloads or write order', async () => {
  const originals = [point('a', '重复文本', { uid: 1 }), point('b', '重复文本', { uid: 2 }), point('c', '不同文本')];
  const h = harness(originals);
  let calls = 0;
  const cached = cacheEmbeddings(async (input) => { calls++; return embed(input); });
  await h.run({}, { embed: cached });
  assert.equal(calls, 2);
  assert.deepEqual(h.client.mutations.filter((m) => m[0] === 'upsert').flatMap((m) => m[2]), ['a', 'b', 'c']);
  for (const original of originals) assert.deepEqual(h.client.row(DEFAULTS.destination).points.get(pointKey(original.id)).payload, original.payload);
});

test('copies collection parameters and complete payload index schemas', () => {
  const spec = collectionSpec({ config: sourceConfig, payload_schema: sourceIndexes });
  assert.deepEqual(spec.create.vectors, sourceConfig.params.vectors);
  assert.deepEqual(spec.create.quantization_config, sourceConfig.quantization_config);
  assert.deepEqual(spec.create.optimizers_config, sourceConfig.optimizer_config);
  assert.deepEqual(spec.indexes[1].field_schema, sourceIndexes.text.params);
  assert.throws(() => collectionSpec({ config: { params: { vectors: { size: 768, distance: 'Cosine' } } } }));
});

test('preserves all IDs/payloads including no-text points and leaves source unchanged', async () => {
  const originals = [point('a'), point('b', ''), point('c', null), { id: 'd', payload: { other: '不猜它是文本' } }];
  const h = harness(originals);
  const before = canonical([...h.client.row(DEFAULTS.source).points.values()]);
  const report = await h.run();
  assert.equal(report.readyForCutover, false);
  assert.equal(report.destinationExactCount, 4);
  assert.equal(report.pass.noText, 3);
  for (const item of originals) assert.deepEqual(h.client.row(DEFAULTS.destination).points.get(pointKey(item.id)).payload, item.payload);
  assert.deepEqual(h.client.row(DEFAULTS.destination).points.get('string:b').vector, {});
  assert.equal(canonical([...h.client.row(DEFAULTS.source).points.values()]), before);
  const final = await h.run({ finalize: true, sourcePaused: true });
  assert.equal(final.readyForCutover, true);
  assert.equal(final.verification.noText, 3);
  assert.equal(final.verification.vectorsChecked, 1);
});

test('resumes a cursor and repeats a page safely after write succeeds but checkpoint save fails', async () => {
  const h = harness([point('a'), point('b'), point('c')]);
  let injected = false;
  await assert.rejects(h.run({}, { save: (value) => {
    if (value.pass.scanned && !injected) { injected = true; throw new Error('simulated checkpoint disk failure'); }
    h.save(value);
  } }), /simulated/);
  assert.equal(h.checkpoint.pass.scanned, 0);
  assert.equal(h.client.row(DEFAULTS.destination).points.size, 2);
  const report = await h.run();
  assert.equal(report.destinationExactCount, 3);
  assert.equal(h.client.row(DEFAULTS.destination).points.size, 3);
});

test('max-batches leaves a resumable partial checkpoint', async () => {
  const h = harness([point('a'), point('b'), point('c')]);
  assert.equal((await h.run({ maxBatches: 1 })).status, 'partial');
  assert.equal(h.checkpoint.pass.scanned, 2);
  assert.equal((await h.run()).status, 'caught_up');
});

test('second online scan captures insertion before the first-pass UUID cursor', async () => {
  const h = harness([point('b'), point('c'), point('d')]);
  let sourcePages = 0;
  h.client.onScroll = (name) => {
    if (name === DEFAULTS.source && ++sourcePages === 2) h.client.row(name).points.set('string:a', point('a', '回填过程中新增'));
  };
  const report = await h.run();
  assert.equal(report.destinationExactCount, 4);
  assert.ok(h.client.row(DEFAULTS.destination).points.has('string:a'));
});

test('catch-up updates edited payloads under existing IDs, not only missing IDs', async () => {
  const h = harness([point('a', '旧事实')]);
  await h.run();
  const firstVector = h.client.row(DEFAULTS.destination).points.get('string:a').vector;
  h.client.row(DEFAULTS.source).points.set('string:a', point('a', '更正后的新事实', { visibility: 'private' }));
  const report = await h.run();
  assert.equal(report.pass.written, 1);
  const updated = h.client.row(DEFAULTS.destination).points.get('string:a');
  assert.equal(updated.payload.visibility, 'private');
  assert.notDeepEqual(updated.vector, firstVector);
});

test('finalization requires paused writers, removes destination-only points and verifies exact counts', async () => {
  const h = harness([point('a'), point('b')]);
  await h.run();
  h.client.row(DEFAULTS.source).points.delete('string:b');
  await assert.rejects(h.run({ finalize: true }), /source-paused/);
  const report = await h.run({ finalize: true, sourcePaused: true });
  assert.equal(report.removedDestinationOrphans, 1);
  assert.equal(report.destinationExactCount, 1);
  assert.equal(report.verification.destinationCount, report.verification.sourceCountAfter);
  assert.equal(report.verification.sampleSearches.length, 1);
  assert.ok(report.verification.sampleSearches[0].vectorCosine >= 0.9999);
  const mutations = h.client.mutations.length;
  assert.equal((await h.run()).readyForCutover, true);
  assert.equal(h.client.mutations.length, mutations);
});

test('same-count source edits during final verification prevent cutover', async () => {
  const h = harness([point('a')]);
  await h.run();
  let reads = 0;
  h.client.onScroll = (name) => {
    if (name === DEFAULTS.source && ++reads === 2) h.client.row(name).points.set('string:a', point('a', '暂停写入声明不实'));
  };
  await assert.rejects(h.run({ finalize: true, sourcePaused: true }), /changed payload|source changed/);
  assert.notEqual(h.checkpoint.status, 'validated');
});

test('refuses checkpoint/model drift, same collection and unowned existing destination', async () => {
  const h = harness([point('a')]);
  await h.run();
  await assert.rejects(h.run({ model: 'different-model' }), /identity mismatch/);
  await assert.rejects(h.run({ destination: DEFAULTS.source }), /must be different/);
  await assert.rejects(h.run({}, { checkpoint: null }), /without its migration checkpoint/);
});

test('failed destination writes do not advance the persisted cursor', async () => {
  const h = harness([point('a', '')]);
  h.client.upsert = async () => { const error = new Error('payload-only unsupported'); error.status = 400; throw error; };
  await assert.rejects(h.run(), /unsupported/);
  assert.equal(h.checkpoint.pass.scanned, 0);
  assert.equal(h.checkpoint.pass.offset, null);
});
