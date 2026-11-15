import { computeEnv } from './env.js';
import { createEmbeddingServer } from './embedding-server.js';
import { createLocalEmbeddingEngine } from '../memory/embedding-local.js';
import { embeddingIdentity } from '../memory/embedding-contract.js';
import { stopEmbeddingServer } from './shutdown.js';

const config = computeEnv();
const identity = embeddingIdentity(config.EMBED_COMPUTE_MODEL);
const server = createEmbeddingServer({ token: config.EMBED_COMPUTE_TOKEN, identity,
  engine: createLocalEmbeddingEngine({ model: config.EMBED_COMPUTE_MODEL, cacheDir: config.EMBED_COMPUTE_CACHE_DIR,
    localOnly: true, verifyDimensions: true }),
  maxConcurrent: config.EMBED_COMPUTE_CONCURRENCY, requestTimeoutMs: config.EMBED_COMPUTE_TIMEOUT_MS,
});
server.listen(config.EMBED_COMPUTE_PORT, config.EMBED_COMPUTE_HOST, () => {
  process.stdout.write(JSON.stringify({ event: 'embedding_compute_listening', host: config.EMBED_COMPUTE_HOST,
    port: config.EMBED_COMPUTE_PORT, identity }) + '\n');
});
server.on('error', () => { process.stderr.write('embedding_compute_server_failed\n'); process.exit(1); });
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  if (stopping) return;
  stopping = true;
  stopEmbeddingServer(server);
});
