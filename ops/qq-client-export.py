#!/usr/bin/python3
"""Fixed-purpose root forced-command; never prints QQ configuration or secrets."""
import contextlib
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

ACCOUNT = '2451779635'
CONTAINER = 'nyatbot-qq'
IMAGE = 'sha256:c8b726cb6e8e73d80b362afd7ab92c090b8a3ca25913c3003491215fab2ba0ed'
SOURCE = Path('/opt/nyatbot-qq/accounts') / ACCOUNT
STAGING = Path('/var/lib/nyatbot-qq-export')
LOCK = Path('/run/lock/nyatbot-qq-export.lock')
DOCKER = '/usr/bin/docker'
MAX_BYTES = 1024 ** 3


def now(): return dt.datetime.now(dt.timezone.utc).isoformat()


def command(args, timeout=15):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    if result.returncode: raise RuntimeError('export_command_failed')
    return result.stdout


def tar_process(args, timeout=37):
    """Own and reap the whole timeout/tar process group before any unpause."""
    process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        if process.wait(timeout=timeout): raise RuntimeError('export_tar_failed')
    except BaseException:
        with signals(ignore=True):
            try: os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: pass
            # The parent can exit on TERM while a grandchild ignores it. Kill
            # the owned group even if the immediate subprocess has already exited.
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            process.wait(timeout=2)
        raise


def private_directory(path):
    if not path.is_absolute() or path.is_symlink() or path.resolve(strict=True) != path or not path.is_dir():
        raise RuntimeError('export_directory_invalid')
    if path.stat().st_uid != 0 or path.stat().st_mode & 0o077:
        raise RuntimeError('export_directory_not_private')
    for parent in path.parents:
        if parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022:
            raise RuntimeError('export_parent_not_trusted')


@contextlib.contextmanager
def locked():
    import fcntl
    fd = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        state = os.fstat(fd)
        if state.st_uid != 0 or state.st_mode & 0o077: raise RuntimeError('export_lock_unsafe')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally: os.close(fd)


def inspect(identifier=CONTAINER):
    data = json.loads(command([DOCKER, 'inspect', identifier]))
    if not isinstance(data, list) or len(data) != 1: raise RuntimeError('export_container_missing')
    return data[0]


def validate_container():
    data = inspect()
    cid = data.get('Id', '')
    if not re.fullmatch('[a-f0-9]{64}', cid) or data.get('Name') != '/' + CONTAINER:
        raise RuntimeError('export_container_identity')
    if data.get('Image') != IMAGE or data.get('Config', {}).get('User') != '10001:10001':
        raise RuntimeError('export_container_image_or_user')
    if not data.get('State', {}).get('Running') or data['State'].get('Paused'):
        raise RuntimeError('export_container_not_available')
    expected = {'/app/.config/QQ': SOURCE / 'profile', '/app/napcat/config': SOURCE / 'config',
                '/app/napcat/cache': SOURCE / 'cache', '/app/napcat/logs': SOURCE / 'logs'}
    mounts = data.get('Mounts', [])
    if len(mounts) != len(expected): raise RuntimeError('export_mount_inventory')
    for mount in mounts:
        target = mount.get('Destination')
        if (target not in expected or mount.get('Type') != 'bind'
                or mount.get('Source') != str(expected[target]) or mount.get('RW') is not True):
            raise RuntimeError('export_mount_mismatch')
        path = expected.pop(target)
        if path.is_symlink() or path.resolve(strict=True) != path or not path.is_dir():
            raise RuntimeError('export_source_symlink')
    if expected: raise RuntimeError('export_mount_missing')
    return cid


def source_size():
    total = 0
    for name in ('profile', 'config'):
        for root, directories, files in os.walk(SOURCE / name, followlinks=False):
            for child in directories + files:
                path = Path(root) / child
                if path.is_symlink(): raise RuntimeError('export_source_symlink')
                if path.is_file(): total += path.stat().st_size
                elif not path.is_dir(): raise RuntimeError('export_source_special_file')
                if total > MAX_BYTES: raise RuntimeError('export_size_limit')
    return total


def ensure_no_guard():
    if (STAGING / 'pause-guard.json').exists() or (STAGING / 'pause-guard.fired').exists():
        raise RuntimeError('export_pause_requires_operator_review')


def persist_guard(cid, unit):
    ensure_no_guard()
    with (STAGING / 'pause-guard.json').open('x', encoding='utf-8') as output:
        json.dump({'version': 1, 'containerId': cid, 'timerUnit': unit, 'createdAt': now()}, output)
        output.flush(); os.fsync(output.fileno())
    fd = os.open(STAGING, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def clear_guard(cid, unit):
    path = STAGING / 'pause-guard.json'
    if path.is_symlink(): raise RuntimeError('export_guard_invalid')
    value = json.loads(path.read_text(encoding='utf-8'))
    if value.get('containerId') != cid or value.get('timerUnit') != unit:
        raise RuntimeError('export_guard_mismatch')
    path.unlink()
    fd = os.open(STAGING, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


def watchdog(cid, unit):
    value = json.loads((STAGING / 'pause-guard.json').read_text(encoding='utf-8'))
    if value.get('containerId') != cid or value.get('timerUnit') != unit:
        raise RuntimeError('export_guard_mismatch')
    marker = STAGING / 'pause-guard.fired'
    if not marker.exists():
        with marker.open('x', encoding='utf-8') as output:
            json.dump({'containerId': cid, 'timerUnit': unit}, output)
            output.flush(); os.fsync(output.fileno())
        fd = os.open(STAGING, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)
    # The durable marker is written BEFORE any possibly ambiguous Docker RPC.
    command([DOCKER, 'unpause', cid])


def stop_watchdog(unit):
    result = subprocess.run(['/usr/bin/systemctl', 'stop', unit + '.timer', unit + '.service'],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
    # --collect may already have unloaded an unused service. systemctl still
    # synchronously stops/cancels the existing timer and service jobs.
    if result.returncode not in (0, 5): raise RuntimeError('export_watchdog_stop_failed')


def arm_resume(cid):
    unit = 'nyatbot-qq-unpause-' + uuid.uuid4().hex
    # Write before arming/pause. A killed or ambiguous pause cannot silently
    # permit another export; only a confirmed pause then resume clears this.
    persist_guard(cid, unit)
    command(['/usr/bin/systemd-run', '--quiet', '--collect', '--unit=' + unit,
             '--on-active=45s', '--timer-property=AccuracySec=1s',
             '--timer-property=RandomizedDelaySec=0', '--timer-property=OnUnitActiveSec=5s',
             '/usr/bin/python3', str(Path(__file__).resolve()), '--watchdog', cid, unit])
    # Verify an independent timer exists before acquiring the pause.
    if command(['/usr/bin/systemctl', 'is-active', unit + '.timer']).strip() != b'active':
        raise RuntimeError('export_watchdog_not_armed')
    return unit


def resume(cid, unit, retire_guard=True):
    # Never operate on a future container that happens to reuse the same name.
    state = inspect(cid).get('State', {})
    if state.get('Paused'): command([DOCKER, 'unpause', cid])
    if inspect(cid).get('State', {}).get('Paused'): raise RuntimeError('export_resume_failed')
    if retire_guard:
        try:
            stop_watchdog(unit)
            # A killed watchdog may have issued an unpause that finishes late.
            # Never allow a new capture while this marker exists.
            if (STAGING / 'pause-guard.fired').exists():
                raise RuntimeError('export_watchdog_requires_operator_review')
        except BaseException:
            command(['/usr/bin/systemctl', 'start', unit + '.timer'])
            raise
        clear_guard(cid, unit)


def capture_tar(cid, target):
    unit = None
    pause_requested = False
    pause_confirmed = False
    started = time.monotonic()
    try:
        unit = arm_resume(cid)
        pause_requested = True  # Also recover an ambiguous docker pause result.
        command([DOCKER, 'pause', cid])
        snapshot_started = now()
        if not inspect(cid).get('State', {}).get('Paused'):
            raise RuntimeError('export_pause_unconfirmed')
        pause_confirmed = True
        tar_process(['/usr/bin/timeout', '--signal=TERM', '--kill-after=5s', '30s',
                 '/usr/bin/tar', '--format=posix', '--numeric-owner', '--hard-dereference',
                 '-cf', str(target), '-C', str(SOURCE), 'profile', 'config'], timeout=37)
        # An early watchdog fire, external resume or an exceeded window invalidates
        # this archive. Do not call it a frozen snapshot just because tar exited 0.
        current = inspect(cid).get('State', {})
        if time.monotonic() - started >= 40 or not current.get('Running') or not current.get('Paused'):
            raise RuntimeError('export_snapshot_window_invalid')
        if not target.is_file() or target.stat().st_size > MAX_BYTES:
            raise RuntimeError('export_archive_invalid')
        return snapshot_started, now()
    finally:
        if unit:
            # Ignore additional stop signals during the bounded recovery attempt;
            # SIGKILL/SSH death is covered by the already armed systemd timer.
            with signals(ignore=True):
                if pause_requested: resume(cid, unit, retire_guard=pause_confirmed)
                else: resume(cid, unit, retire_guard=True)
            # If resume/inspection failed, timer cancellation is never reached.


@contextlib.contextmanager
def signals(ignore=False):
    old = {}
    def interrupt(_signum, _frame): raise RuntimeError('export_interrupted')
    try:
        for sig in (signal.SIGTERM, signal.SIGINT, *([signal.SIGHUP] if hasattr(signal, 'SIGHUP') else [])):
            old[sig] = signal.signal(sig, signal.SIG_IGN if ignore else interrupt)
        yield
    finally:
        for sig, handler in old.items(): signal.signal(sig, handler)


def export(output):
    private_directory(STAGING)
    cid = validate_container()
    size = source_size()
    if shutil.disk_usage(STAGING).free < size * 2 + 128 * 1024 ** 2:
        raise RuntimeError('export_insufficient_local_space')
    with tempfile.TemporaryDirectory(prefix='capture-', dir=STAGING) as temporary:
        raw, packed = Path(temporary) / 'snapshot.tar', Path(temporary) / 'snapshot.tar.gz'
        started, completed = capture_tar(cid, raw)
        # QQ is already resumed; compression and slow SSH transfer cannot extend
        # its pause. The staged tar is private and immutable from this point.
        with raw.open('rb') as source, packed.open('xb') as sink:
            with gzip.GzipFile(fileobj=sink, mode='wb', compresslevel=3, mtime=0) as zipped:
                shutil.copyfileobj(source, zipped, 1024 * 1024)
            sink.flush(); os.fsync(sink.fileno())
        digest = hashlib.sha256()
        with packed.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''): digest.update(block)
        metadata = {'version': 1, 'kind': 'qq-client', 'account': ACCOUNT,
                    'containerId': cid, 'imageId': IMAGE, 'consistency': 'crash_consistent',
                    'snapshotStartedAt': started, 'snapshotCompletedAt': completed,
                    'sameInstantAsCentral': False, 'bytes': packed.stat().st_size,
                    'sha256': digest.hexdigest()}
        output.write(json.dumps(metadata, sort_keys=True).encode() + b'\n')
        with packed.open('rb') as stream: shutil.copyfileobj(stream, output, 1024 * 1024)
        output.flush()


def main():
    os.umask(0o077)
    if os.geteuid() != 0: raise RuntimeError('export_root_forced_command_required')
    if len(sys.argv) == 4 and sys.argv[1] == '--watchdog':
        if not re.fullmatch('[a-f0-9]{64}', sys.argv[2]) or not re.fullmatch('nyatbot-qq-unpause-[a-f0-9]{32}', sys.argv[3]):
            raise RuntimeError('export_watchdog_arguments_invalid')
        private_directory(STAGING)
        watchdog(sys.argv[2], sys.argv[3])
        return
    if len(sys.argv) != 1: raise RuntimeError('export_root_forced_command_required')
    action = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    if action not in ('nyatbot-qq-export-v1', 'nyatbot-qq-preflight-v1'):
        raise RuntimeError('export_action_denied')
    with locked(), signals():
        ensure_no_guard()
        if action == 'nyatbot-qq-preflight-v1':
            private_directory(STAGING)
            cid = validate_container()
            print(json.dumps({'version': 1, 'ready': True, 'account': ACCOUNT, 'containerId': cid,
                              'imageId': IMAGE, 'sourceBytes': source_size(), 'paused': False}))
        else: export(sys.stdout.buffer)


if __name__ == '__main__':
    try: main()
    except BaseException:
        # A traceback/subprocess response may contain private profile information.
        print('qq_export_failed', file=sys.stderr)
        raise SystemExit(1)
