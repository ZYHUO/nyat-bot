# Memory source authority and projection recovery

The source body and its provenance are committed to SQLite before an embedding or
Qdrant request when `MEMORY_PROJECTION_OUTBOX_ENABLED=true`. The same transaction
creates a projection job. The flag defaults to false. This is one SQLite authority;
it does not make SQLite a cross-machine queue or provide multi-primary HA.

[Source store](../src/memory/source-store.ts) retains the actual platform/account,
mapped conversation/message, optional topic, input event identity, body, visibility,
and a monotonic source version. Incoming F11 event identities are validated against
the mapped destination. Assistant sources come from actual acknowledged delivery
parts. Existing vectors are not relabelled, imported as public, or assigned the
current bot account. A legacy-only deletion record is a tombstone, not a recovered
message or a claim about who originally observed it.

Source-backed writes require a validated ingress event identity. A plain old
FormattedMessage cannot be assigned the current token's account. The CodeAct ACK
loop uses the separate `memorizeAcknowledgedDelivery` entry point, building identity
only for a confirmed platform message. Old queued jobs and public-channel scraper
records with synthetic negative hash chat IDs cannot satisfy this contract and are
rejected while the flag is enabled; migrate them using proven original identities
or keep them in a separate external-source collection. Do not mint current-account
identities during backfill. Visibility overrides cannot make a DM or sensitive
source public.

The [projector](../src/memory/projection-worker.ts) runs as `memory-projection` in
the existing heartbeat, nominal interval 15 seconds (heartbeat resolution may be
30 seconds). Each claim gets a unique lease token. It checks the current source
version and lease after embedding and before writing. Qdrant writes wait for a
confirmed operation. Their point IDs include source version and model/collection
identity; a late old RPC cannot overwrite a new point. The vector checkpoint is
stored before the FTS transaction. A crash after vector confirmation or an FTS
failure retries only unfinished work once that checkpoint is durable. A crash
before checkpointing may repeat the same idempotent vector upsert.

All new vector hits must resolve to the current, non-retracted SQLite source.
Neither vector payload text nor an obsolete source version is injected. Editing a
source immediately hides its old projection while the replacement is pending.
Retraction clears the authoritative body and immediately blocks reads, including
after the write flag is disabled. The actual OneBot recall transaction and existing
`deleteMemories` entry point create these tombstones. Projection deletes are then
retried. Disabling the flag pauses projection processing; it does not restore
forgotten messages. There is no automatic undelete.

Repeated delivery of the same ingress event does not create another version.
An older original or edit cannot replace a newer event. Same-body edits still
advance event ordering. Near-duplicate coalescing is deliberately not applied to
source-backed writes: original bodies must not disappear merely because a vector
looks similar. Existing recall/protection counters keep their logical chat/message
IDs; versioned vector IDs are not substituted into that interface.

Each awaited embedding/vector step has a 20-second deadline and a drain stops
claiming more work after its 20-second batch budget. This bounds the waiting worker;
it does not claim to interrupt native embedding computation or revoke an already
accepted remote RPC. Late embedding completion cannot start a vector write; late
remote writes remain subject to the source-version/tombstone reader checks.

Failures back off up to one hour and move to `failed` after eight attempts. The
queue retains stage-only diagnostic codes, never provider exception bodies or
credentials. Heartbeat observations and `memory projection tick` logs expose
counts, oldest pending time and last completed time. Operators can inspect
`memoryProjectionStats()` and, after fixing the cause, invoke
`retryFailedMemoryProjections(limit)` in the authenticated local maintenance
environment. Retry only selects the current source version and current configured
model/collection. Do not update every row to pending or change stored model names
to force incompatible vectors into the current collection.

Rollback keeps migration 0126 and its source/tombstone tables. Rolling back to an
older binary that ignores these guards can make retained stale vectors readable;
that is not a safe rollback. Keep the source-aware reader or restore a verified,
coherent data snapshot. Old and new embedding spaces must not be mixed. A remote
embedding service is a later compute boundary and is not implemented here.

Limits: source persistence is atomic with its own outbox, not with every prior
ingress receipt. F11 marks a crashed in-progress handler unknown instead of
automatically replaying side effects; repair must inspect that receipt. A late
superseded Qdrant operation may leave an unreadable stale point until cleanup;
source-version checks prevent it being returned, but it can temporarily occupy a
retrieval candidate. Existing historical vectors remain in their old provenance
class. Long-term memory remains conversation-scoped; topic metadata does not claim
that all historical vectors have topic-level isolation.
