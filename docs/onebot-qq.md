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
ONEBOT_MEDIA_ENABLED=true
ONEBOT_GROUP_FILE_SOURCE=message
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
The normal migration runner applies [identity mappings](../migrations/0118_platform_identity.sql),
[request decisions](../migrations/0119_onebot_requests.sql), and
[notice/recall state](../migrations/0120_onebot_notices.sql).
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
| Incoming images, voice, video, documents | Bounded authenticated streaming, same-chat opaque handles, shared vision/transcription/document pipeline |
| Private files and group uploads | Ordinary file segments by default; an explicit notice mode supports clients without group file messages |
| Outgoing media | Chunk upload to the QQ host, then one message send with a real message ID; works across two hosts |
| Generated files | The isolated agent can send UTF-8 text files without arbitrary server filesystem access |
| Stickers | Same-chat image/GIF handles; Telegram sticker IDs and its global sticker library are not portable |
| Reactions | Single-codepoint emoji send; incoming feedback depends on the QQ client and is not treated as proven sentiment |
| Friend requests / group applications / invitations | Durable pending requests, explicit owner-only private approval/rejection commands |
| Member changes / bans / leaving a group | Recorded membership state; confirmed absence or mute suppresses sending |
| Message recall | Filters current context and quoted copies; queued/in-progress task anchors prevent later sending |
| Check-in, cards, games, memory, diary, goals | Reuse the shared business/cognition pipeline and its existing flags and permissions |
| Native polls, edit, pin, moderation tools, forwards, typing | Not exposed by this QQ adapter; no Telegram fallback and no invented success |

The historical `telegram.sendText` / `telegram.sendFinal` host API names are kept
for compatibility, but the task's bound conversation chooses the actual platform.
QQ tasks receive a narrower model/RPC capability list. Unsupported capabilities
cannot become available merely because old prompts mention them.

## Request review

Send these commands in a private chat from `ONEBOT_OWNER_ID` to this bot:

- `/qqrequests` (or `QQ申请`): show up to 20 current pending requests with opaque IDs.
- `/qqapprove ID` (or `QQ通过 ID`): approve exactly that request.
- `/qqreject ID reason` (or `QQ拒绝 ID 理由`): reject exactly that request.
- `/qqrequests history`: show recent outcomes; `/qqhelp` displays help.

No request is automatically approved. Group join approval requires a fresh client
confirmation that the bot is a group owner/admin; an invitation requires the
explicit owner command. Requests expire after 24 hours. A decision is persisted
before the API call. Uncertain outcomes remain held for manual QQ-side checking,
including after a process restart; repeating a command cannot blindly resend it.

## Attachment boundaries

`ONEBOT_MEDIA_ENABLED` defaults to false. Enable it with a compatible NapCat
stream API. The verified protocol implementation is NapCat 4.18.42. Media chunks
are 48 KiB, with overall deadlines, byte limits, authenticated account checks,
ordered chunks and upload SHA-256 validation. A stream stays on one connection.
Photos/voice/video are limited to 10 MiB; file sending is limited to 50 MiB.
The shared analysis pipeline may apply tighter limits than file transport.

`ONEBOT_GROUP_FILE_SOURCE=message` is the default and the choice for NapCat
4.18.42. That client emits both a normal group file message and a `group_upload`
notice. The normal message contains a real message ID and a cached file UUID;
the notice can use an MD5-based asset ID and its construction time instead of
the original message time. Treating them as the same exact event is unreliable.
NyatBot therefore consumes one representation: normal group file messages in
`message` mode, group-upload notices in `notice` mode. Use the latter only for a
client that needs it. Notice IDs are local opaque IDs and are never sent as QQ
quote/delete IDs. Text accompanying a filtered file, other media, and private
file messages keep their normal routes. This avoids filename/time heuristics
that could discard two separate uploads of equally named files.

Incoming references expire after 24 hours and are bound to their source
conversation. Reading or resending another chat's reference is refused. QQ CDN
downloads validate DNS and every redirect; local/private URLs and arbitrary
QQ-host paths are never accepted as read capabilities. Upload receipt paths are
used only for the immediate send on that same authenticated connection.

The isolated QQ agent has `telegram.readFile(handle)`, `telegram.sendFile(handle)`,
`telegram.sendPhoto(handle)`, `telegram.sendSticker(handle)`,
`telegram.sendTextFile(filename,text)` and `telegram.sendVoice(text)` when enabled.
The historical namespace does not send QQ content to Telegram. Voice output still
requires a working TTS provider; successful transport cannot make an unavailable
model support vision, audio or video. Attachment contents remain untrusted data.

Recall suppresses live context and future replies. It is not a promise to erase
every historical vector memory, audit record, backup, or already-delivered reply.

## Reply timing

QQ and Telegram share the same reply timing pipeline. Ordinary group messages can reach
Heart without mentioning the bot: Heart may reply, wait, or pass. Existing mute,
sleep, Meta activation and conversation-scope restrictions still apply.

For QQ groups, `META_QQ_GROUP_COALESCE_MS=1500` and
`META_QQ_GROUP_COALESCE_MAX_MS=4000` collect successive messages **before** Heart
decides. Every message is stored separately; after 1.5 seconds of quiet (at most
four seconds from the first pending message), Heart sees the complete context
once. A text decision enters Attention with the original batch references, so
the task uses the last bubble as its anchor and retains the others as related
messages. The final response may omit a visible quote.
The default quiet window is `0` (off). The queue permits at most 64 chats, 32
pending messages per chat and four judgments in flight; excess candidates stay
in stored context and emit a capacity diagnostic. Shutdown cancels pending
judgments and prevents late dispatch. Pending input is not automatically replayed
after restart.

With `META_QQ_MENTION_HEART_ENABLED=true` (default false), QQ group mentions,
name calls and replies to the bot retain priority but ask Heart which response
fits: text, reaction, wait or pass. Addressing anywhere in a batch is retained,
even when its last bubble has no mention. Questions and requests are prioritized
in the decision prompt; an unavailable model preserves addressed input as a
wait rather than dropping it. Private messages and explicit command handlers
keep their existing routes. Telegram is unaffected by these QQ settings.

`META_QQ_HEART_REFRACTORY_MS` optionally changes only QQ groups' passive reply
cooldown. Its default, `0`, inherits `META_HEART_REFRACTORY_MS` (45 seconds by
default). A value of `10000` lets Heart reconsider ordinary QQ messages ten
seconds after a confirmed text reply; it still may wait or pass, and an active
CodeAct task still blocks another passive reply. Direct mentions and replies
to the bot retain their priority. Telegram's cooldown is unchanged. QQ reaction
success, rejection, or uncertain delivery does not start a text reply or take
the text cooldown lock; failed reactions are not automatically retried.

To combine short private-message or direct-mention bursts, set
`META_DIRECT_COALESCE_MS=800` and `META_DIRECT_COALESCE_MAX_MS=2000`. The bot waits
for 800 ms of quiet in that conversation, capped at two seconds from its first
pending message, then dispatches the batch once with the last message as its
reply anchor. Other conversations and task callbacks keep their own timing.
The default is `META_DIRECT_COALESCE_MS=0`, which preserves the existing fast
path. Passive group chatter retains the separate `META_L0_COALESCE_MS` window
(2800 ms by default) and Heart/timing decisions. This batches work; it does not
promise that a task will send only one bubble or silence follow-up questions.

## QQ reply style and displayed identity

QQ text replies use the current conversation's task context. Omitting `replyTo`
sends an ordinary bubble; a visible quote is added only for an explicitly supplied
message ID from that task's permitted quotes. The internal trigger and related
messages still participate in answered bookkeeping and topic context.

A reply of at most 120 Unicode characters stays in one bubble unless it contains
an explicit line break. Longer text may split at a complete sentence boundary,
with at most two bubbles of 120 characters each and 240 characters in total.
URLs and code spans are not cut, and content is never silently truncated. Text
that cannot fit is rejected before the first send with guidance to shorten it or
use the available text-file attachment tool. Short replies do not need two bubbles.

The QQ CodeAct task budget counts confirmed bubbles across resumed segments,
capped at three (or a lower configured/task-specific limit). Concurrent calls
reserve their complete planned reply before sending. A failed or uncertain later
bubble cannot erase the first bubble's confirmed count. The failure-report path
uses this same policy; it cannot bypass the budget or force a visible quote.
Telegram retains its existing quotation, splitting and budget behavior.

QQ uses the authenticated account's login nickname, with the optional
`ONEBOT_DISPLAY_NAME` override. Recognized call names include that platform's
display/login names and configured nicknames. QQ prompts and self-message
recognition use the mapped QQ account identity, not Telegram's username or UID.

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

## Video understanding fallback

Video transport and model understanding are separate capabilities. When native
`video` inference fails or returns no text, `VIDEO_FRAME_FALLBACK_ENABLED=true`
allows the [frame extractor](../src/pipeline/video-frames.ts) to send up to three
sampled images to the configured `vision` route. It samples the beginning and
roughly one-third/two-thirds positions; very short or low-frame-rate clips may
yield fewer images. These are sampled pictures, not semantically selected key
frames or a complete viewing of the video. **No audio track is supplied**: the
description must not claim to have heard speech or sound.

The default is off. `VIDEO_FFMPEG_PATH` must point to a separately installed
restricted FFmpeg executable, with `ffprobe` beside it. The deployment build
supports MOV/MP4, Matroska/WebM and AVI containers with H.264, HEVC, VP8, VP9,
MPEG-4 Part 2, MJPEG and raw-video decoders. AV1 and other formats are not
guaranteed. It has no network protocols or playlist demuxers. MOV external file
references are disabled. The extractor accepts downloaded bytes only, never a
remote URL or caller-supplied file path.

Limits are 10 MiB input, at most 300 seconds (or the lower configured duration),
16 megapixels per input frame, three PNG outputs with sides no larger than 640
pixels, and a shared 20-second extraction deadline. Linux process memory/CPU/file
limits, one decoder thread and a two-extraction concurrency cap bound resource
use. Unsupported or refused clips retain a neutral video placeholder. Image
sampling is a fallback; it does not establish full audiovisual understanding or
prove that every supported container/codec combination has been tested live.

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
