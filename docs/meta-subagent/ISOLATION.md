# Meta / CodeAct execution boundary

Generated JavaScript no longer executes in the application process. `meta/session`,
`subagent/executor`, and the older `MetaSandbox` facade all use the same OS runner.
`MetaSandbox.execute` is now asynchronous. A disabled or unavailable runner rejects
the turn; there is no AsyncFunction, vm, worker-thread, or unsandboxed process fallback.

## Linux deployment profile

The 2026-11-14 full-chat release uses the existing non-root `nyatbot` account
(uid 993/gid 989) and `NoNewPrivileges=true`. Kernel 3.10 has user namespaces
compiled in. The initial failures had two independent causes: the namespace
quota was zero, and RLIMIT_NPROC=32 was below the service UID's existing thread
count. The deployment enables a namespace quota of 128 and uses the fixed
RLIMIT_NPROC=256 profile described below.

Bubblewrap 0.13.1 and libcap 2.78 were built from upstream archives checked against
their published SHA256 sums and installed under `/opt/nyatbot-sandbox`. The fixed
runtime and library files are root-owned and are not writable by the service.
There are no setuid bits, sudo rules or root execution broker.

Release gates run the exact runner as uid 993/gid 989 with no-new-privileges:
13 OS integration proofs cover filesystem/host-file hiding, kernel denial of
sockets and forks, finite memory, loop termination, RPC denial, ordering,
cancellation and concurrent guests. A synthetic real-model probe also verifies
Meta → isolated JavaScript → scoped capability RPC, bound to the release SHA256.
Its capabilities are test doubles; it sends no Telegram message and does not
establish real-user delivery. The deployment evidence records the actual results.

Full takeover uses `META_SUBAGENT_ENABLED=true`,
`CODEACT_ISOLATION_ENABLED=true` and empty `META_SUBAGENT_CHAT_IDS` (all chats).
Startup requires a successful real isolation preflight and a positive activation
timestamp. Earlier queued tasks, callbacks, defer records and wait anchors are
held for audit instead of replayed. The cutoff stays fixed across ordinary
service restarts. Defaults remain off for other installations. See
[upstream documentation](https://github.com/containers/bubblewrap) and
[the option reference](https://github.com/containers/bubblewrap/blob/v0.13.1/bwrap.xml).

## Fixed policy

- A separate Node process inside fresh mount, PID, network, IPC and UTS namespaces.
- Only Node and an explicit list of trusted, regular ELF library files are mounted.
  No application tree, credentials, home, broad `/usr`, or host `/proc` is exposed.
- The filesystem and private proc mount are read-only; only null/urandom devices
  are present. All application environment variables are removed.
- The guest has uid/gid 65534, zero effective/permitted capabilities, no-new-privileges
  and a mandatory seccomp filter, verified BEFORE generated code is sent to it.
- The root-only test path grants the trusted bootstrap just SETUID/SETGID so it can
  drop identity before reading the code. It is not a production root broker.
- Hard address-space limit 512 MiB, JS heap limit 64 MiB, CPU limit 3 seconds,
  wall-time limit at most 30 seconds and 64 FDs; one guest per app process.
  RLIMIT_NPROC is 256 host-UID threads, including the bot's existing ONNX and Node
  pools. It is not a per-guest limit; the former value of 32 blocked namespace
  creation when the production UID already owned 67 threads. Guest process forks
  and namespace creation remain denied by seccomp.
  Fork/vfork/non-thread clone and sockets are denied by seccomp. Threads share the
  same address-space limit; SysV allocations and memfd are also denied.
- Output, source, RPC arguments and results have byte/depth/count limits. Unknown
  methods, duplicate request IDs and prototype paths are rejected.
- A FIFO accepts at most 16 waiting guests; the total deadline includes queue
  wait and preflight. The next guest starts only after the previous child closes.
  Failure to tear it down blocks further guests until the service restarts.
- Meta sessions, summaries, journal inputs and task lookups are scoped to their
  source chat. Unscoped historical summaries are retained but not injected.

The boundary still shares the host kernel. It does not remove legacy-kernel bugs
or validate the business permissions of a host capability. A capability already
started before timeout may finish; killing a guest cannot undo a network request
already accepted by an external service. Host APIs retain their scope/consent/rate
checks, and no new queued RPC is started after timeout/cancellation.

## Explicit capability RPC

The guest receives method names and JSON values, never host objects or functions.
The parent selects only own data-property functions from an explicit allowlist;
Meta dispatch capabilities and CodeAct capabilities have separate lists. RPC is
serial, capped at 32 calls, and drains calls whose generated code forgot `await`.
Unawaited failures are surfaced. Useful send acknowledgement text and IDs survive
serialization.

The first profile supports text/voice/sticker responses, scoped read/search tools,
Meta requests and selected task bookkeeping. Arbitrary terminal/browser code,
direct file operations, prompt mutation, administrative actions, bot delegation,
cross-chat delivery and image generation are NOT exported. Their existing host
implementations are not made safe merely by moving JS into another process.
`SANDBOX_ENABLED` remains a separate flag for existing computer tools.

## Verification and activation

```sh
# In an isolated checkout without .env, using its Node 22 and dependencies:
node --import tsx scripts/sandbox/preflight.mts PROFILE.json
node --import tsx scripts/sandbox/verify-isolation.mts PROFILE.json
npx vitest run --maxWorkers=2 tests/unit/sandbox/codeact-policy.test.ts
```

The integration proof uses only fake capabilities and a synthetic canary file.
Its socket test targets namespace-local loopback and is denied at socket creation;
it sends no real external message or request. The staging-only example profile is
`scripts/sandbox/profile-centos7-staging.json`; do not point production at a mutable
build directory.

Runtime configuration is default-off:

```dotenv
CODEACT_ISOLATION_ENABLED=false
CODEACT_ISOLATION_BWRAP_PATH=/usr/bin/bwrap
CODEACT_ISOLATION_RUNTIME_FILES=
```

Before activation, run the exact preflight/proof under the real service identity
and restrictions. Back up the old release, environment, SQLite and relevant Redis
state; require no pending work at the stop boundary. Install the tested release,
set a fresh activation cutoff, then start the service. The deployment script
restores the previous code, environment and namespace settings if startup fails.
It does not overwrite live databases during rollback. Check ingress, worker and
Meta startup logs in addition to `/health`, which is only a liveness endpoint.
