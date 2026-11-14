# QQ / OneBot v11

NyatBot can connect an already logged-in QQ client through a **forward WebSocket**
OneBot v11 endpoint. Messages enter the same cognition ingress as Telegram,
including Meta, context, memory and reply timing. The adapter does not log in to QQ
and does not implement reverse WebSocket, HTTP event ingress or OneBot v12.

This follows the connection direction described by the
[MaiBot OneBot adapter guide](https://docs.maibot.chat/manual/adapters/qq-local-client).
MaiBot's plugin depends on its own SDK; NyatBot uses its own adapter rather than
loading that plugin. The protocol is defined by the
[OneBot WebSocket specification](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)
and [authentication specification](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md).

## Configure the client

1. Install a currently maintained OneBot v11 client using its own documentation.
2. Log in with the bot's QQ account and enable its **forward WebSocket server**.
3. Enable access-token authentication. Use the combined root endpoint, not the
   API-only or event-only endpoints. A common same-machine address is
   `ws://127.0.0.1:3001/`; match the port actually configured in the client.
4. For another machine, use WSS or an SSH tunnel bound to loopback. Cleartext WS
   is accepted only on loopback. Never place the token in the URL.

## Configure NyatBot

Copy these values into the private environment file and fill in the identities
and the same access token used by the QQ client:

```dotenv
ONEBOT_ENABLED=true
ONEBOT_WS_URL=ws://127.0.0.1:3001/
ONEBOT_ACCESS_TOKEN=replace-with-your-client-token
ONEBOT_ACCOUNT_ID=123456789
ONEBOT_OWNER_ID=987654321
ONEBOT_ALLOWED_GROUP_IDS=
ONEBOT_ALLOWED_USER_IDS=
ONEBOT_ACTION_TIMEOUT_MS=30000
ONEBOT_HEARTBEAT_INTERVAL_MS=30000
ONEBOT_RECONNECT_DELAY_MS=5000
```

Empty group/user lists allow all conversations on this QQ account. To restrict
access, use comma-separated **raw QQ numbers**. These are access filters, not a
Meta rollout list. The bot and owner accounts must differ. The owner setting
identifies the QQ owner within that account; it does not grant Telegram admin
commands or merge that person with Telegram's owner.

The existing Telegram token is still required by this combined application.
Meta retains its existing activation/isolation requirements. Empty
`META_SUBAGENT_CHAT_IDS` covers both platforms. A numeric Meta scope list contains
internal mapped conversation IDs, not raw QQ group numbers.

Install dependencies with Node 22, build, and restart using your service manager.
The normal migration runner applies [0118_platform_identity.sql](../migrations/0118_platform_identity.sql).
Back up SQLite before upgrading and retain it across restarts: the mapping is
persistent application data, not a disposable cache.
Multiple ingress/worker processes must share that same SQLite database as well
as Redis. Separate per-host SQLite copies are not a supported distributed setup.

## Supported behavior

| Capability | Behavior |
| --- | --- |
| Private/group text | Shared ingress, context, memory and Meta reply path |
| Mention bot/person | Explicit user identity; another person's mention does not wake the bot |
| Quote/reply | Same-conversation message mapping; absent quote text is marked unavailable |
| Send confirmation | Requires successful OneBot status, retcode and message ID |
| Delete | Confirms the OneBot delete result; permissions remain with the QQ client |
| Reconnect | Bounded backoff, login identity verification on each connection, ping/pong |
| Incoming media | Explicit unavailable-content placeholder; text in the same message is retained |
| Outgoing media, polls, reactions, edit, moderation, forward, typing | Unavailable in this adapter; no Telegram fallback and no invented success |

The historical `telegram.sendText` / `telegram.sendFinal` host API names are kept
for compatibility, but the task's bound conversation chooses the actual platform.
QQ tasks receive a narrower model/RPC capability list. Unsupported capabilities
cannot become available merely because old prompts mention them.

## Identity and delivery guarantees

QQ references include platform, bot account, ID namespace, conversation kind and
native ID. A transactional SQLite mapping assigns safe internal numeric IDs
outside Telegram's documented 52-bit range. Groups remain negative for the
existing core; private conversations share their mapped user's positive ID.
Identical QQ and Telegram numbers cannot share memory or be sent through the
wrong transport. A final grammY API guard also rejects reserved internal IDs,
including unknown IDs and direct/raw API calls.

Ingress uses a Redis 24-hour duplicate claim before dispatch. Redis errors stop
QQ ingestion. An event already claimed is not automatically replayed if handling
was interrupted: the protocol provides no transactional acknowledgement for the
application's later side effects. This is not an exactly-once delivery claim.

Socket timeout or disconnect after a send means **delivery unknown**, not failure
to deliver. The transport never replays that request. A CodeAct task with unknown
delivery stops sending, records failure, and cannot automatically resume, send a
fallback or trigger Meta to retry. The metadata-only Redis hash
`xxb:codeact:delivery-unknown` retains task holds without TTL. The host records an
in-flight intent before sending; failure to persist it prevents the send. A
confirmed receipt or a definite not-sent/rejected result clears only that exact
attempt. Unknown results, crashes and cleanup failures retain the hold. Only after checking
the QQ chat and removing obsolete queued/resume work should an operator remove
the exact task's field. Do not clear the entire hash or promise delivery without a receipt.

## Observe and verify

The authenticated monitor endpoint `GET /monitor/api/onebot` reports connection
state, pending requests, queued events and heartbeat time, without endpoint or
token. `ready` requires a matching `get_login_info` identity. The application's
general health endpoint only proves process liveness. QQ connection failure does
not stop Telegram; the disconnected QQ sender explicitly fails.

Protocol tests use real loopback WebSocket frames, SQLite migrations, and the
shared ingress. They cover mentions/replies, duplicate events, namespace
collisions, authentication, wrong accounts, frame limits, reconnect and unknown
delivery. They do not establish compatibility with an untested QQ client or
prove live QQ login. After configuring a real client, verify a private message,
a group mention, a quote, and a reconnect from your own accounts before relying
on the connection.

See the [recorded validation results and remaining test limitations](onebot-validation.md).
