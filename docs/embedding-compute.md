# Independent embedding compute

The bot remains the SQLite/Qdrant authority. The separate embedding executable
accepts bounded text batches and returns vectors. It has no Telegram/QQ credential,
Redis connection, SQLite database, queue consumer, cron, or delivery capability.
One host may run several separately configured modules; this service does not make
the bot active-active or move its state database.

Build with the normal tsup build. Start the resulting
[compute entry](../src/compute/embedding-entry.ts) as the generated
dist/embedding-compute.js executable. Its dedicated environment parser does not
load the bot's .env. Supply only:

```dotenv
EMBED_COMPUTE_TOKEN=<separate-random-secret-at-least-32-characters>
EMBED_COMPUTE_MODEL=Xenova/paraphrase-multilingual-MiniLM-L12-v2
EMBED_COMPUTE_CACHE_DIR=/absolute/path/to/transformers/cache
EMBED_COMPUTE_HOST=127.0.0.1
EMBED_COMPUTE_PORT=3032
EMBED_COMPUTE_CONCURRENCY=1
EMBED_COMPUTE_TIMEOUT_MS=15000
```

The [minimal runtime lock and service template](../ops/embedding/README.md) describe
the independent Linux dependency installation, loopback SSH tunnels and bounded
shutdown. No bot environment or credential file is part of that runtime package.

Use the exact model already used by the authority, with the same copied model
artifacts. The service requires complete local weights/config/tokenizer files and
does not silently download a replacement model. A failed/incomplete model load
leaves authenticated health at 503. Set the host to the trusted private interface
when another machine must connect. Restrict it with the host firewall or a private
network; use TLS when the network is not trusted. Do not expose plain HTTP with a
bearer token on an untrusted route. Keep the token in the service credential file,
not shell history, URLs, screenshots, public logs, or the main bot's prompt.
Before reporting ready, the standalone entry runs a fixed synthetic native probe
and verifies that the model actually returns 384 finite dimensions.

Configure the authority explicitly; these settings default to remote disabled:

```dotenv
MEMORY_REMOTE_EMBED_ENABLED=true
MEMORY_REMOTE_EMBED_ENDPOINTS=http://trusted-primary:3032,http://trusted-standby:3032
MEMORY_REMOTE_EMBED_TOKEN=<same-compute-secret>
MEMORY_REMOTE_EMBED_TIMEOUT_MS=5000
MEMORY_REMOTE_EMBED_LOCAL_FALLBACK=true
```

Only operator-configured origins are used, at most four in order. Credentials,
query strings and non-root paths in endpoint URLs are rejected. Redirects are
never followed. A request timeout, failed status, incompatible identity or invalid
vector may try the next configured endpoint. Local fallback is explicit and uses
the same configured model and preprocessing identity. Disabling remote mode returns
to the original local engine without changing the collection or reindexing.
The first model identity is pinned for the process lifetime; a hot model-name
change is rejected and requires an intentional restart/migration.

The authenticated API is GET /health and POST /v1/embeddings. Requests contain
`identity` and `texts`; responses contain the same identity and `vectors`. Texts
are **raw strings on the wire**. Both local and remote engines apply exactly once:

```js
`${rawText.length}:${rawText.slice(0, 512)}`
```

This intentionally preserves the existing length-prefixed UTF-16/512-character
representation, mean pooling, normalization and 384 dimensions. The preprocessing
identity is `legacy-length-prefix512-v1`. Correcting that old representation,
switching weights or model family, or changing dimensions is a separate migration
into a new vector collection. Neither the compute service nor this rollout does
that migration. Check model artifact hashes and representative local/remote vectors
before switching production endpoints; the string model ID alone is not an artifact
hash or proof of identical downloaded weights.

The request limit is 16 raw texts, 16,384 characters each and 256 KiB total JSON.
Responses are limited to 512 KiB, with exact batch length, finite numbers and the
expected dimensions. Oversized input is rejected by remote compute; an explicitly
enabled local fallback may process it with the unchanged legacy preprocessing.
No server text/body is logged. The client reports bounded failure codes rather than
echoing remote response bodies or secrets.

The server checks auth before reading bodies, rejects incompatible identity before
running native inference, and has a fixed concurrency bound. A response deadline
or client disconnect does **not** free the native slot: it remains occupied until
actual inference settles. New requests get 429 while capacity is occupied. Health
reports readiness, identity, inflight count, capacity and oldest active duration.
A stuck native runtime requires a process restart; pretending cancellation stopped
native work would overcommit the small compute hosts.

Tests exercise real local HTTP authentication, ordered failover, redirects, request
and response limits, timeouts, identity rejection, fallback and native slot holding.
Model execution in those unit tests uses synthetic vectors. Hardware/model loading
and vector equivalence on the intended HK/TW hosts require deployment probes. No
standby is considered usable merely because it has this role configured.
