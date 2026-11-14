# Memory, attention and compression boundaries

QQ and Telegram use distinct stored identities. A raw number or display name is
not evidence that two users, accounts or conversations are the same. Privacy
checks are unconditional; an old feature flag cannot grant disclosure rights.

## What can enter a reply

- Proven history from the current conversation remains usable. Private chats and
  sensitive groups cannot be exported into unrelated audiences. The separate
  owner-DM reader links only that owner's own messages and their bot conversations;
  it never imports another person's DM. See [linked owner memory](linked-owner-memory.md).
- Cross-conversation memory requires explicit public visibility, a known source,
  and matching platform/account provenance. Contextual memories remain local.
  Unknown or conflicting source metadata fails closed, including vector and
  lexical retrieval results. Old records are preserved, not relabeled public.
- The bot's group directory is metadata, not a grant to read group messages.
  Membership is checked against the current platform/account. A partial directory,
  failed query or permission restriction never proves that the bot is absent.
  Explicit `OWNER_MEMORY_LINK_ENABLED=true` binds the configured Telegram and QQ
  owner identities; by default each owner retains only their own platform view.
- Private nicknames and merged global identity fields do not automatically become
  group facts. Cognitive belief and world-state reads no longer include unscoped
  global records in a chat/task request. Experiences must join to an episode in
  the same conversation. Stored skills and loop policies without conversation
  provenance are not injected into chat replies; their storage is retained.
- Explicit administrator-authored persona/permanent knowledge remains configured
  input. This change does not establish provenance for arbitrary manually edited
  files or perform a semantic audit of all historical text.

## Attention and recovery

Attention is checked both on enqueue and before consumption. QQ account, message,
user and quoted-message references must resolve to their actual conversation.
Recalled messages are rechecked. Callbacks must resolve to the original persisted
task and its chat. Bad source metadata is held for audit, never repaired by changing
its chat label. Temporary store failures retain attention for retry.

Checkpoints carry platform, account, chat, topic and task identity. A missing,
unscoped or mismatched checkpoint holds the continuation instead of starting it
again. A valid continuation uses the current system prompt. New tasks without a
checkpoint are unaffected. QQ quiet/max batching windows are unchanged.

## Compression

Agent compression budgets new progress separately from old summaries, preserves
the task goal and recent user corrections, and retains the latest turns. Only
whole turns actually sent to the summarizer may be replaced. Failure retains the
original history. Summaries are reference material, not fresh instructions or proof
that a planned action succeeded.

Mid-term summaries carry the same scope plus author/message/reply anchors. Redis
topic summaries are separate. CodeAct now consumes scoped mid-term memory as well
as the legacy reply path. Old summaries without provenance remain stored but are
not injected. The legacy NyatDB arithmetic topic key cannot safely represent all
IDs; mid-term summarization for its sole-store topic mode is withheld rather than
falling back to the General topic.

Long-term vector recall remains scoped to the whole Telegram group; it does not
claim isolation between forum topics. Topic isolation here applies to recent
context, mid-term summaries and task checkpoints.

The context-engine diagnostic cache stores hashes, lengths and bounded metadata,
not full prompt text. Its reuse metric is local prefix equality, not a claim about
provider token caching.

## Outgoing information

Both text senders reject high-confidence credential formats and configured runtime
secrets before transport. This includes edits, poll text, captions, text exports
and TTS input; Telegram's final API middleware also checks structured payloads.
Blocked errors contain only a stable reason, not the secret. Automatic grounding
does not run on DMs or sensitive chats. Search queries containing credentials or
obvious personal identifiers are rejected before any provider is called.

These are layered controls, not a promise to recognize every kind of personal
information. Binary documents, archives, image text and audio are not semantically
scanned by the credential filter. Attachment handles still require the same source
conversation, and generated code cannot select arbitrary server files. Model
processing uses the configured providers; platform separation does not imply local
model inference.

Tests use synthetic canaries, isolated SQLite/Redis and mocked outbound effects.
They check both rejection and normal same-conversation behavior without posting
private content into real chats.
