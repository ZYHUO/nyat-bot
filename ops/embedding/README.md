# Standalone compute runtime

This directory is a deployment template, not an installer or a production status
claim. It does not read or copy the bot environment, database, Redis state or tokens.

The [runtime package](package.json) and [lock](package-lock.json) contain only the
dependency closure required by the compute bundle. They were derived from the
repository lock using [derive-lock.mjs](derive-lock.mjs), without registry resolution.
Direct dependencies are pinned to @xenova/transformers 2.17.2, onnxruntime-node 1.14.0,
lru-cache 11.3.3 and zod 3.25.76. The closure pins sharp 0.32.6, which transformers
imports even for text models. The native ONNX runtime is a required direct dependency
so an installation cannot silently omit the intended native CPU engine.

Prepare a fresh Linux runtime directory; do not copy Windows node_modules or the
bot's entire node_modules. Copy only the generated embedding-compute.js bundle,
its optional source map, and these two package files. With the same Node 22 binary
used by the service, run npm ci --omit=dev in that independent directory. Normal
install scripts are needed for sharp's native dependency; ignore-scripts alone is
not a validated runtime. The package-lock integrity covers npm tarballs, while
sharp's separately downloaded libvips binary also needs installation validation.
If offline, copy a previously verified Linux dependency closure for the same
architecture/libc and record its manifest; do not substitute a different model,
package version or broken native dependency just to obtain a passing process.

The unit expects the install directory at /opt/nyat-embedding and Node at
/opt/node22/bin/node; adjust that explicit binary path to the verified host runtime.
Create a dedicated unprivileged nyat-embed user, its writable state directory
/var/lib/nyat-embedding, and a root-owned mode-600 service environment at
/etc/nyat-embedding/compute.env from [the example](compute.env.example).
The example token is a placeholder and must be replaced by a distinct random
compute credential; never reuse BOT_TOKEN or copy production .env.

Copy the exact authority model directory into the cache layout
/opt/nyat-embedding/models/<configured-model-id>, including tokenizer/config/ONNX
files. The model tree and program/dependencies should be read-only to the service
user. Hash the source and destination trees and compare representative local/remote
vectors before enabling routing. A model-name match alone does not prove artifact
equivalence. See [the protocol contract](../../docs/embedding-compute.md).

Keep EMBED_COMPUTE_HOST=127.0.0.1. For this rollout the authority reaches each
compute host through an authenticated SSH local forward; no public HTTP listener
or firewall opening is required. Configure the authority's ordered endpoints to
the local tunnel ports, for example http://127.0.0.1:13032 followed by
http://127.0.0.1:23032. Tunnel liveness is separate from authenticated model health;
a listening forwarding port does not establish compute readiness.

[The service unit](nyat-embedding.service) is a capacity template. The 640 MiB
limit is not evidence that a host with 680 MiB available can run the model safely.
Measure actual cold-load peak, repeated inference RSS, CPU latency and concurrent
timeout behavior under the intended memory limit. Leave room for the OS, SSH and
existing processes. A host that fails the native load, vector comparison or memory
headroom check is not a ready standby and must stay out of the endpoint list.
Do not install on a host that was excluded from this rollout.

On SIGTERM/SIGINT the entry stops accepting connections and closes idle HTTP
connections. It explicitly exits when active HTTP closes, or after five seconds
forces connection closure and exits with failure. This can terminate outstanding
native work; it is not a native-drain guarantee. The service owns no durable writes,
and the authority treats incomplete requests as failed and tries its next endpoint
or configured local fallback. TimeoutStopSec=10 and KillMode=control-group provide
an OS-level bound even if a native runtime blocks JavaScript timers. Graceful HTTP
completion must never be described as durable delivery or completed inference.

Rollback disables MEMORY_REMOTE_EMBED_ENABLED or removes a failed endpoint and
uses the original local engine with the same pinned model/preprocessing/collection.
It does not require deleting data or regenerating vectors. Keep source/model and
runtime manifests alongside each release so a restart cannot quietly change the
vector space.
