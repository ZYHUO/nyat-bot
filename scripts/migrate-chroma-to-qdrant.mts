// One-time migration: ChromaDB (:8400) → Qdrant (:6333).
// Pulls every point (id + embedding + document + metadata) from the live Chroma
// collection and bulk-upserts into Qdrant, mapping the string id → UUIDv5 via the
// SAME midToPointId the app uses. Idempotent (upsert). Run: npx tsx scripts/migrate-chroma-to-qdrant.mts [--probe]
import { ChromaClient } from 'chromadb';
import { QdrantClient } from '@qdrant/js-client-rest';
import { midToPointId } from '../src/memory/chroma.js';

const COLLECTION = 'xxb_group_history';
const probe = process.argv.includes('--probe');

const chroma = new ChromaClient({
  host: process.env.CHROMA_HOST ?? 'localhost',
  port: parseInt(process.env.CHROMA_PORT ?? '8400', 10),
  ssl: false,
});
const qdrant = new QdrantClient({ host: '127.0.0.1', port: 6333, https: false });

const col = await chroma.getOrCreateCollection({
  name: COLLECTION,
  embeddingFunction: null as never,
  metadata: { 'hnsw:space': 'cosine' },
});
const total = await col.count();
console.log(`Chroma total: ${total}`);

if (!probe) {
  const { collections } = await qdrant.getCollections();
  if (!collections.some((c) => c.name === COLLECTION)) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: 384, distance: 'Cosine', on_disk: true },
      quantization_config: { scalar: { type: 'int8', quantile: 0.99, always_ram: true } },
    });
    await qdrant.createPayloadIndex(COLLECTION, { field_name: 'chatId', field_schema: 'integer', wait: true });
    console.log('Qdrant collection created');
  }
}

const BATCH = probe ? 2 : 1000;
const limit = probe ? 2 : total;
let migrated = 0;

for (let offset = 0; offset < limit; offset += BATCH) {
  const res: any = await col.get({
    limit: Math.min(BATCH, limit - offset),
    offset,
    include: ['embeddings', 'documents', 'metadatas'] as never,
  });
  const ids: string[] = res.ids ?? [];
  const embs: number[][] = res.embeddings ?? [];
  const docs: (string | null)[] = res.documents ?? [];
  const metas: Record<string, unknown>[] = res.metadatas ?? [];

  if (probe) {
    console.log('sample id:', ids[0], '| emb len:', embs[0]?.length, '| doc:', String(docs[0]).slice(0, 40), '| meta keys:', Object.keys(metas[0] ?? {}));
    break;
  }

  const points = [];
  for (let i = 0; i < ids.length; i++) {
    const vector = embs[i];
    if (!vector || vector.length !== 384) continue;
    const m = metas[i] ?? {};
    points.push({
      id: midToPointId(ids[i]!),
      vector: Array.from(vector),
      payload: {
        mid: ids[i],
        chatId: m['chatId'], messageId: m['messageId'], uid: m['uid'],
        username: m['username'], fullName: m['fullName'], timestamp: m['timestamp'], role: m['role'],
        text: docs[i] ?? '',
      },
    });
  }
  if (points.length) await qdrant.upsert(COLLECTION, { wait: true, points });
  migrated += points.length;
  if (offset % 10000 === 0 || offset + BATCH >= limit) console.log(`migrated ${migrated}/${total}`);
}

if (!probe) {
  const info = await qdrant.getCollection(COLLECTION);
  console.log(`DONE. Qdrant points: ${info.points_count}`);
}
process.exit(0);
