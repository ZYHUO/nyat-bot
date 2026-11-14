#!/opt/nyatbot-python/bin/python3.12
"""Fetch one fixed QQ profile snapshot. No credentials or profile text on stdout."""
import contextlib
import datetime as dt
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import uuid

ROOT = Path('/var/lib/nyatbot-backup/qq-client')
KEY = Path('/etc/nyatbot-backup/qq-export_ed25519')
HOSTS = Path('/etc/nyatbot-backup/qq_known_hosts')
ACCOUNT = '2451779635'
IMAGE = 'sha256:c8b726cb6e8e73d80b362afd7ab92c090b8a3ca25913c3003491215fab2ba0ed'
MAX_BYTES = 1024 ** 3
GENERATION = re.compile(r'qq-[a-f0-9]{32}')


def private(path, directory=False):
    if path.is_symlink() or path.resolve(strict=True) != path or not path.is_absolute():
        raise RuntimeError('collector_path_invalid')
    if (path.is_dir() if directory else path.is_file()) is not True:
        raise RuntimeError('collector_path_type')
    if path.stat().st_uid != 0 or path.stat().st_mode & 0o077:
        raise RuntimeError('collector_path_not_private')
    for parent in path.parents:
        if parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022:
            raise RuntimeError('collector_parent_not_trusted')


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(fd)
    finally: os.close(fd)


@contextlib.contextmanager
def locked():
    import fcntl
    fd = os.open(ROOT / '.collect.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if os.fstat(fd).st_uid != 0 or os.fstat(fd).st_mode & 0o077:
            raise RuntimeError('collector_lock_unsafe')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally: os.close(fd)


def fetch(destination, preflight=False):
    private(KEY); private(HOSTS)
    def limit_output():
        import resource
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES + 16384, MAX_BYTES + 16384))
    args = ['/usr/bin/ssh', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
            '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
            '-o', 'UserKnownHostsFile=' + str(HOSTS), '-i', str(KEY),
            'root@216.236.7.21', 'nyatbot-qq-preflight-v1' if preflight else 'nyatbot-qq-export-v1']
    with destination.open('xb') as output:
        # The output file limit bounds even a malformed peer before parsing.
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=output,
                                stderr=subprocess.DEVNULL, timeout=150, check=False,
                                preexec_fn=limit_output)
        output.flush(); os.fsync(output.fileno())
    if result.returncode: raise RuntimeError('collector_fetch_failed')


def read_header(stream):
    line = stream.readline(16385)
    if len(line) > 16384 or not line.endswith(b'\n'): raise RuntimeError('collector_header_limit')
    value = json.loads(line)
    if not isinstance(value, dict): raise RuntimeError('collector_header_invalid')
    if (value.get('version') != 1 or value.get('kind') != 'qq-client'
            or value.get('account') != ACCOUNT or value.get('imageId') != IMAGE
            or not re.fullmatch('[a-f0-9]{64}', str(value.get('containerId', '')))
            or value.get('consistency') != 'crash_consistent'
            or value.get('sameInstantAsCentral') is not False
            or type(value.get('bytes')) is not int or not 0 < value['bytes'] <= MAX_BYTES
            or not re.fullmatch('[a-f0-9]{64}', str(value.get('sha256', '')))):
        raise RuntimeError('collector_header_identity')
    times = []
    for key in ('snapshotStartedAt', 'snapshotCompletedAt'):
        parsed = dt.datetime.fromisoformat(value[key])
        if parsed.tzinfo is None: raise RuntimeError('collector_timestamp_invalid')
        times.append(parsed)
    current = dt.datetime.now(dt.timezone.utc)
    if not times[0] <= times[1] <= current + dt.timedelta(seconds=30) or current - times[0] > dt.timedelta(minutes=10):
        raise RuntimeError('collector_snapshot_stale')
    # Keep only a fixed, non-secret metadata schema from the remote peer.
    return {key: value[key] for key in ('version', 'kind', 'account', 'imageId', 'containerId',
            'consistency', 'sameInstantAsCentral', 'bytes', 'sha256', 'snapshotStartedAt', 'snapshotCompletedAt')}


def validate_archive(path):
    count = total = 0
    roots = set()
    with tarfile.open(path, 'r|gz') as archive:
        for member in archive:
            count += 1
            name = PurePosixPath(member.name)
            if (not name.parts or name.parts[0] not in ('profile', 'config') or name.is_absolute()
                    or '..' in name.parts or '\\' in member.name or ':' in member.name
                    or not (member.isdir() or member.isfile())):
                raise RuntimeError('collector_archive_unsafe')
            roots.add(name.parts[0]); total += member.size
            if count > 200000 or total > MAX_BYTES: raise RuntimeError('collector_archive_limit')
    if roots != {'profile', 'config'}: raise RuntimeError('collector_archive_incomplete')


def seal(bundle, incoming):
    archive = incoming / 'snapshot.tar.gz'
    with bundle.open('rb') as source:
        metadata = read_header(source)
        digest = hashlib.sha256(); size = 0
        with archive.open('xb') as output:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                size += len(block)
                if size > metadata['bytes']: raise RuntimeError('collector_length_mismatch')
                digest.update(block); output.write(block)
            output.flush(); os.fsync(output.fileno())
        if size != metadata['bytes'] or digest.hexdigest() != metadata['sha256']:
            raise RuntimeError('collector_hash_mismatch')
    validate_archive(archive)
    with (incoming / 'metadata.json').open('x', encoding='utf-8') as output:
        json.dump(metadata, output, sort_keys=True); output.write('\n'); output.flush(); os.fsync(output.fileno())
    bundle.unlink()
    generation = 'qq-' + uuid.uuid4().hex
    fsync_dir(incoming)
    incoming.rename(ROOT / generation); fsync_dir(ROOT)
    receipt = {**metadata, 'archiveRoot': str(ROOT), 'generation': generation}
    pending = ROOT / ('.current-' + uuid.uuid4().hex)
    try:
        with pending.open('x', encoding='utf-8') as output:
            json.dump(receipt, output, sort_keys=True); output.write('\n'); output.flush(); os.fsync(output.fileno())
        pending.replace(ROOT / 'CURRENT.json'); fsync_dir(ROOT)
    finally: pending.unlink(missing_ok=True)
    # Delete only prior sealed generations created by this collector, after the
    # new receipt is durable. Failures retain extra backups, never lose current.
    for prior in ROOT.iterdir():
        if prior.name != generation and GENERATION.fullmatch(prior.name):
            try:
                private(prior, directory=True)
                shutil.rmtree(prior)
            except OSError: pass
    return receipt


def main():
    os.umask(0o077)
    if os.geteuid() != 0 or sys.argv[1:] not in ([], ['--preflight']):
        raise RuntimeError('collector_invocation_denied')
    private(ROOT, directory=True)
    with locked(), tempfile.TemporaryDirectory(prefix='.incoming-', dir=ROOT) as temporary:
        incoming = Path(temporary); bundle = incoming / 'bundle'
        if sys.argv[1:] == ['--preflight']:
            fetch(bundle, preflight=True)
            if bundle.stat().st_size > 16384: raise RuntimeError('collector_preflight_limit')
            value = json.loads(bundle.read_bytes())
            if value.get('ready') is not True or value.get('paused') is not False or value.get('account') != ACCOUNT or value.get('imageId') != IMAGE:
                raise RuntimeError('collector_preflight_invalid')
            print(json.dumps({'ready': True, 'account': ACCOUNT, 'paused': False}))
        else:
            fetch(bundle)
            print(json.dumps(seal(bundle, incoming), sort_keys=True))


if __name__ == '__main__':
    try: main()
    except BaseException:
        print('qq_collector_failed', file=sys.stderr)
        raise SystemExit(1)
