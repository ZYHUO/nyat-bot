# QQ client backup

The daily controller can opt into a fixed pre-capture collector. The default
configuration has no hook. The collector runs only for a due capture, under the
deployment lock, before stopping central bot writers. A failure aborts that
backup without advancing its daily success receipt.

Install the tested controller separately at /opt/nyatbot-backup/app/scripts/backup-controller.py,
owned by root with no group/other write permission on it or any parent. The
root service must never execute the bot-owned checkout. Apply the same ownership
rule to the Python runtime, collector, exporter and their control directories.
The root config may set pre_capture_script to /opt/nyatbot-backup/bin/collect-qq.py
and must include /var/lib/nyatbot-backup/qq-client in archives. Optional
release_manifest_file points to /opt/nyatbot/RELEASE.json: its revision and the
full actual dist hash inventory must match config.release before capture.
Production also pins release_manifest_sha256 in the root-owned config. The
controller hashes and parses the same bytes, so replacing both the bot-owned
manifest and code cannot preserve that root-pinned proof. Without this optional
hash, the manifest check proves self-consistency only.

The collector uses a dedicated root-only SSH key and a pinned host key. The
remote authorized key has a source IP restriction, restrict, and a forced
command. That command accepts only the versioned export and read-only preflight
actions; it never interprets an arbitrary remote command. Neither the private
key nor Google credentials belong in Git. Google credentials stay on the central
host. The local --preflight option does not pause the client.

The exporter is fixed to account 2451779635, the inventoried image digest and
the exact profile/config/cache/log bind inventory. It stages only the complete
profile and config, not cache or logs. Before pause it arms an independent
systemd timer to unpause the exact container ID after 45 seconds, repeating every
5 seconds even after failures. A durable guard is created before timer/pause;
each watchdog invocation records its own durable marker before any Docker RPC.
Local tar is
bounded to 30 seconds plus a 5-second kill grace. After tar, it verifies that the
container is still paused and the freeze window has not expired. Finally and
TERM/INT/HUP recover immediately; SIGKILL or SSH loss leaves the timer available.
Tar and its timeout wrapper run in an owned process group; timeout or interruption
terminates and reaps that whole group before recovery proceeds. A confirmed pause
and unpause can stop the timer and service only when no watchdog invocation marker
exists. An ambiguous pause, watchdog invocation or failed recovery retains the
guard and repeating timer. New exports and preflight refuse until an operator
verifies the exact container, finishes all pending Docker work, stops both exact
units and explicitly clears the guard/marker. This prevents a late pause or old
unpause from escaping into a later capture. Compression and network transfer
happen after the client resumes, so they cannot extend its pause.

The collector verifies the fixed metadata, SHA-256, exact byte length and safe
tar member types without extracting. It seals a new private generation, atomically
replaces CURRENT.json, then removes only old collector-owned sealed generations.
An interrupted or failed fetch preserves the prior current generation. After a
successful seal, a detected untrusted old generation causes the hook to fail
conservatively even though the new CURRENT is already durable; it is not a
successful daily backup. Ordinary filesystem cleanup errors retain extra copies.
After a
SIGKILL, stale private incoming/export staging directories can remain; investigate
and remove those only after confirming no exporter or collector is running.

QQ is a **crash-consistent, slightly earlier snapshot**, not an application-level
flush and not simultaneous with the central SQLite/Redis/Qdrant snapshot. The
central manifest records this boundary explicitly. Recover it only in isolation;
do not start two logged-in QQ clients with the same restored session. A snapshot
does not guarantee the upstream provider will accept a restored login. Preserve
the pinned container image separately when its public registry availability is
uncertain. Tests simulate watchdog ownership and kill paths; an actual forced
kill of the production exporter is not part of the automated test suite.
