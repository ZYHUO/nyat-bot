# Isolated video compute replicas

This is a separate runtime, not a second bot worker. It uses only a Node 22 bundle
and pinned local ELF files. It does not read the bot environment, SQLite, Redis,
NyatDB, Qdrant, platform credentials, model credentials or conversation IDs.
The default bot configuration keeps remote video disabled.

Build the video-compute entry in [tsup configuration](../../tsup.config.ts). Verify
the build metafile contains only Node built-in external imports, then install its
bundle and [runtime package](package.json) in a fresh root-owned runtime directory.
No npm installation or bot node_modules is needed. The service UID must not be
able to edit its code, profile, decoder or libraries. Use a dedicated nyatvideo
account and an explicitly verified Node 22 executable. The [unit](nyat-video.service)
uses systemd directives compatible with the older deployment host; its memory and
CPU limits are capacity limits, not evidence that a particular host is ready.

Install a root-owned profile with this shape. Replace every sample path and digest
with a verified file; no directories or symlink sources are permitted:

```json
{
  "bwrap": { "path": "/opt/nyatbot-video-compute/bin/bwrap", "sha256": "actual 64 hex characters" },
  "prlimit": { "path": "/opt/nyatbot-video-compute/bin/prlimit", "sha256": "actual 64 hex characters" },
  "ffmpeg": { "path": "/opt/nyatbot-video-compute/bin/ffmpeg", "sha256": "actual 64 hex characters" },
  "ffprobe": { "path": "/opt/nyatbot-video-compute/bin/ffprobe", "sha256": "actual 64 hex characters" },
  "runtimeFiles": [
    { "path": "/opt/nyatbot-video-compute/elf/libc.so.6", "sha256": "actual 64 hex characters", "mountPath": "/lib64/libc.so.6" }
  ]
}
```

The actual runtimeFiles list must include every required loader/library for both
decoders. Determine it from verified ELF metadata and the fixed decoder build;
do not mount a host library directory. Each file is checked for canonical path,
root ownership, non-writable parents, non-setid mode, ELF magic and SHA-256.
An optional library mountPath specifies the exact in-sandbox loader location.
It may only name a library file below the standard lib directories. The runtime
binds just those ELF files and one private input file. It unshares user, PID,
network, IPC and UTS namespaces, drops capabilities, clears the environment and
mounts its root read-only. No host home, temporary directory, application directory
or database is mounted. The decoder has no writable output file; PNG bytes use
stdout. Only file input and pipe output are required in the restricted FFmpeg build.

Use [the environment template](compute.env.example), root-owned mode 0600. Generate
a dedicated random ASCII token, 32–256 characters, and do not put it in process
arguments or logs. Compute the decoder identity from the two verified decoder
SHA-256 strings, in ffmpeg then ffprobe order, using JSON.stringify and SHA-256.
Libraries and launchers remain separately hash checked. Startup runs an actual
isolated ffprobe process before listening; an unsupported user namespace or loader
therefore cannot advertise ready. A successful preflight does not replace a real
video decode acceptance test.

Keep both services bound to loopback. The authority can reach a remote replica
through an authenticated SSH local forward and reach its own independent replica
directly. Use separate UIDs and limits for video and embedding, even on one host.
Only the dedicated compute token is shared; platform/model tokens stay on the
authority. An open forwarding port is not readiness: use the authenticated health
endpoint and verify the pinned decoder identity.

The authority's five bot controls are VIDEO_REMOTE_ENABLED, VIDEO_REMOTE_ENDPOINTS,
VIDEO_REMOTE_TOKEN, VIDEO_REMOTE_DECODER_SHA256 and VIDEO_REMOTE_TIMEOUT_MS.
VIDEO_FRAME_FALLBACK_ENABLED must also be true. Ordered endpoints are trusted
operator configuration, never model/user URLs. Enable remote routing only after
both real replicas pass acceptance. When enabled, failed replicas do not fall back
to the legacy local subprocess. All failures produce the existing neutral video
placeholder. Disabling remote routing restores the previous configured behavior.

## Contract and limits

POST /v1/video/frames accepts only application/octet-stream bytes, at most 10 MiB.
Headers bind the protocol, decoder digest, input digest, duration bound and remaining
deadline. No URL, host path, codec command or model prompt is accepted. Redirects
are refused. Inputs are copied before asynchronous client work. Each operation has
one total deadline, at most 20 seconds, shared across up to four explicit endpoints.
Time is reserved for a later replica; an unfinished pure computation can be retried
without replaying a message send or database write.

The server reserves capacity before buffering the upload. Default concurrency is
one, hard maximum two, with at most sixteen connections. Child resource limits
cover CPU, address space, open files, processes, output files and core dumps.
Input duration is at most 300 seconds and 4096×4096 pixels. Output is one to three
PNG frames, at most 640×640 and 2 MiB per frame. The client bounds the response to
9 MiB and checks protocol, decoder/input binding, base64, PNG dimensions, ordering
and sampling times. It returns frames only; it does not interpret audio or claim
to have processed a full video.

Timeout and caller disconnect cancel the request and kill the decoder process
group. Capacity is retained until actual child close, including pipes. Shutdown
stops admissions, cancels active work and joins it; a five-second hard shutdown
fallback and systemd control-group kill bound an uncooperative child. Private
temporary input files are removed after close, and systemd PrivateTmp limits
crash leftovers to the unit's private temporary namespace. Logs contain static
status and runtime identity only, never bytes, input filenames or auth headers.

Platform download and source permission checks remain on the authority. QQ source
recall is rechecked after remote computation and before the vision call, and again
before returning its result. Vision and other paid model calls, prompt construction,
task cancellation, memory updates and platform sending remain local to the authority.

## Acceptance and remaining limits

The offline unit suite exercises real local HTTP replicas with synthetic byte
fixtures, including failover, binding errors, redirects, slow uploads, overload,
disconnect, timeout and shutdown join. Separate decoder tests inspect launch/mount
policy and actual-close accounting. Those tests mock the native subprocess and
do not establish that a remote Linux host can decode video.

Before enabling production routing, run the fixed bundle as the real service UID
on both Linux hosts: verify the asset manifest, isolated preflight and synthetic
video decode; then verify primary failure selects the second replica, cancellation
reaps actual children, external file references cannot read a synthetic host canary,
and network namespaces differ. Check memory/CPU under the installed limits. These
checks must not send a Telegram/QQ message or use live attachments.

This adds redundancy for frame extraction only. It does not provide failover for
the authority, platform login, SQLite/NyatDB, Redis or Qdrant. Configuration roles
are not distributed ownership leases. The old heterogeneous embedding rejection
remains in force and is unaffected by this media-only module.
