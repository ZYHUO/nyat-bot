#!/usr/bin/env python3
"""Quiesced local snapshots and encrypted Google Drive upload. Python >= 3.12.

This controller never restores into production or prints subprocess output or
credentials. Retention touches only sealed, verified generations in the crypt prefix.
"""
import argparse
import contextlib
import datetime as dt
import hashlib
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

RUN_RE = re.compile(r"^nyatbot-\d{8}T\d{6}Z-[a-f0-9]{12}$")
NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$")
MEMBER_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,239}$")
UNIT_RE = re.compile(r'[a-zA-Z0-9_.@-]+\.service')
PRODUCER = 'nyatbot-backup-controller'
RETENTION = {'daily': 14, 'weekly': 8, 'monthly': 12}


class BackupInterrupted(Exception):
    """A normal catchable interruption, so writer recovery runs in finally."""


@contextlib.contextmanager
def handle_stop_signals(ignore=False):
    def interrupt(_signum, _frame):
        raise BackupInterrupted('backup_interrupted')
    previous = {}
    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.signal(signum, signal.SIG_IGN if ignore else interrupt)
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def fsync_directory(path):
    if os.name == 'posix':
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(fd)
        finally: os.close(fd)


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def parsed_utc(value):
    if not isinstance(value, str): raise RuntimeError('invalid_backup_timestamp')
    parsed = dt.datetime.fromisoformat(value)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RuntimeError('backup_timestamp_requires_timezone')
    return parsed.astimezone(dt.timezone.utc)


def backup_logical_day(now=None):
    now = now if now is not None else dt.datetime.now(dt.timezone.utc)
    if now.tzinfo is None or now.utcoffset() is None:
        raise RuntimeError('backup_timestamp_requires_timezone')
    # Shanghai has no DST: 04:00 UTC+8 is the start of each backup day.
    return (now.astimezone(dt.timezone(dt.timedelta(hours=8))) - dt.timedelta(hours=4)).date().isoformat()


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, value):
    path = Path(path)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            json.dump(value, out, ensure_ascii=False, sort_keys=True, indent=2)
            out.write('\n'); out.flush(); os.fsync(out.fileno())
        temp.replace(path)
        fsync_directory(path.parent)
    finally:
        temp.unlink(missing_ok=True)


def private_file(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise RuntimeError('required_private_file_missing_or_symlink')
    if os.name == 'posix' and path.stat().st_mode & 0o077:
        raise RuntimeError('private_file_permissions_must_be_0600')
    return path


def require_root_owner(path):
    if os.name == 'posix' and Path(path).stat().st_uid != 0:
        raise RuntimeError('private_control_file_must_be_root_owned')


def command(args, timeout=600, env=None):
    # A command error can include credentials or raw application records.
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, check=False, env=env)
    if result.returncode:
        raise RuntimeError('command_failed:' + Path(args[0]).name)
    return result.stdout


def canonical(path):
    original = Path(path)
    if not original.is_absolute() or original.is_symlink():
        raise RuntimeError('absolute_nonsymlink_path_required')
    resolved = original.resolve(strict=True)
    # Refuse symlinks in any parent too, including the backup/config roots.
    if resolved != original:
        raise RuntimeError('symlink_parent_refused')
    return resolved


def validate_identity_metadata(value):
    release = value.get('release')
    embedding = value.get('embedding')
    if not isinstance(release, str) or not re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', release) or set(release) == {'0'}:
        raise RuntimeError('verified_full_release_required')
    if not isinstance(embedding, dict):
        raise RuntimeError('embedding_metadata_required')
    model, dimensions = embedding.get('model'), embedding.get('dimensions')
    if (not isinstance(model, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_./-]{0,511}', model)
            or any(word in model.lower() for word in ('replace_with', 'unrecorded', 'unknown', 'placeholder'))
            or '..' in model.split('/') or model.lower() in ('todo', 'model')
            or type(dimensions) is not int or not 1 <= dimensions <= 65536):
        raise RuntimeError('invalid_embedding_metadata')
    collection = embedding.get('collection')
    if not isinstance(collection, str) or not NAME_RE.fullmatch(collection) or 'replace_with' in collection.lower():
        raise RuntimeError('embedding_collection_required')
    if 'vector_name' in embedding and (not isinstance(embedding['vector_name'], str) or not NAME_RE.fullmatch(embedding['vector_name'])):
        raise RuntimeError('invalid_embedding_vector_name')


def journal_path(filename):
    path = Path(filename)
    if not path.is_absolute() or path.is_symlink() or canonical(path.parent) != path.parent:
        raise RuntimeError('invalid_shutdown_journal_path')
    parent = path.parent.stat()
    require_root_owner(path.parent)
    if os.name == 'posix' and parent.st_mode & 0o077:
        raise RuntimeError('shutdown_journal_parent_must_be_root_private')
    if path.exists():
        private_file(path)
        require_root_owner(path)
    return path


def validate_writers(config):
    writers = config.get('writers')
    if not isinstance(writers, list) or not 1 <= len(writers) <= 32:
        raise RuntimeError('writer_inventory_required')
    units = [writer.get('unit') for writer in writers if isinstance(writer, dict)]
    if len(units) != len(writers) or any(not isinstance(unit, str) or not UNIT_RE.fullmatch(unit) for unit in units) or len(set(units)) != len(units):
        raise RuntimeError('invalid_writer_unit')


def load_recovery_config(filename):
    # Recovery must work even when data/model/backup storage caused capture to fail.
    path = private_file(canonical(filename))
    require_root_owner(path)
    config = json.loads(path.read_text(encoding='utf-8'))
    validate_writers(config)
    journal_path(config['shutdown_journal'])
    return config


def overlaps(a, b):
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


def quarantine_root(config):
    root = canonical(config['quarantine_root'])
    if not root.is_dir(): raise RuntimeError('quarantine_root_must_be_directory')
    require_root_owner(root)
    if os.name == 'posix' and root.stat().st_mode & 0o077:
        raise RuntimeError('quarantine_root_must_be_private')
    protected = [canonical(config[key]) for key in ('project_root', 'staging_root')]
    protected.append(canonical(config['sqlite_path']).parent)
    for item in config['archives']:
        source = canonical(item['path'])
        protected.append(source if source.is_dir() else source.parent)
    if any(overlaps(root, source) for source in protected):
        raise RuntimeError('quarantine_root_must_be_disjoint')
    return root


def load_config(filename):
    config = load_recovery_config(filename)
    for key in ['project_root', 'staging_root', 'sqlite_path', 'lock_file', 'writers', 'archives', 'redis', 'qdrant', 'quarantine_root']:
        if key not in config: raise RuntimeError('incomplete_backup_config:' + key)
    project = canonical(config['project_root'])
    staging = canonical(config['staging_root'])
    if project == staging or staging.is_relative_to(project) or project.is_relative_to(staging):
        raise RuntimeError('backup_and_project_roots_must_be_disjoint')
    canonical(config['sqlite_path'])
    for writer in config['writers']:
        canonical(writer['checkpoint_dir'])
    seen = set()
    for item in config['archives']:
        if not NAME_RE.fullmatch(item['name']) or item['name'] in seen:
            raise RuntimeError('invalid_or_duplicate_archive_name')
        seen.add(item['name']); canonical(item['path'])
    if config['redis'].get('dedicated_instance') is not True:
        raise RuntimeError('redis_snapshot_requires_dedicated_instance')
    validate_identity_metadata(config)
    retention_policy(config)
    quarantine_root(config)
    if config.get('pre_capture_script') is not None: trusted_hook(config['pre_capture_script'])
    return config


def trusted_hook(filename):
    path = canonical(filename)
    if not path.is_file(): raise RuntimeError('pre_capture_script_must_be_file')
    for item in (path, *path.parents):
        require_root_owner(item)
        if os.name == 'posix' and item.stat().st_mode & 0o022:
            raise RuntimeError('pre_capture_script_path_writable')
    if os.name == 'posix' and not path.stat().st_mode & 0o100:
        raise RuntimeError('pre_capture_script_not_executable')
    return path


def verify_live_release(config):
    filename = config.get('release_manifest_file')
    if filename is None: return
    project = canonical(config['project_root'])
    path = canonical(filename)
    if path != project / 'RELEASE.json' or not path.is_file():
        raise RuntimeError('release_manifest_location_invalid')
    if os.name == 'posix' and (path.stat().st_uid not in (0, project.stat().st_uid) or path.stat().st_mode & 0o022):
        raise RuntimeError('release_manifest_owner_or_mode_invalid')
    raw = path.read_bytes()
    expected_hash = config.get('release_manifest_sha256')
    if expected_hash is not None:
        if not isinstance(expected_hash, str) or not re.fullmatch('[a-f0-9]{64}', expected_hash):
            raise RuntimeError('release_manifest_expected_hash_invalid')
        if hashlib.sha256(raw).hexdigest() != expected_hash: raise RuntimeError('release_manifest_expected_hash_mismatch')
    value = json.loads(raw)
    if value.get('revision') != config['release']: raise RuntimeError('live_release_revision_mismatch')
    recorded = value.get('dist')
    if not isinstance(recorded, dict) or 'index.js' not in recorded:
        raise RuntimeError('live_release_dist_inventory_missing')
    actual = {}
    for item in canonical(project / 'dist').rglob('*'):
        if item.is_symlink(): raise RuntimeError('live_release_dist_symlink')
        if item.is_file(): actual[item.relative_to(project / 'dist').as_posix()] = digest(item)
    if actual != recorded: raise RuntimeError('live_release_dist_mismatch')


def run_pre_capture(config):
    filename = config.get('pre_capture_script')
    if filename is None: return None
    path = trusted_hook(filename)  # Revalidate inside the deployment lock.
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen([str(path)], stdin=subprocess.DEVNULL, stdout=output,
            stderr=subprocess.DEVNULL, cwd=str(path.parent), start_new_session=True,
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/root'})
        try:
            if process.wait(timeout=175): raise RuntimeError('pre_capture_failed')
        except BaseException:
            # Kill the whole local collector/SSH group; the remote exporter has
            # its own independent exact-container unpause timer.
            with handle_stop_signals(ignore=True):
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try: process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=2)
            raise
        if output.tell() > 16384: raise RuntimeError('pre_capture_receipt_limit')
        output.seek(0); value = json.load(output)
    if (not isinstance(value, dict) or value.get('kind') != 'qq-client'
            or value.get('version') != 1 or value.get('consistency') != 'crash_consistent'
            or value.get('sameInstantAsCentral') is not False
            or not re.fullmatch(r'qq-[a-f0-9]{32}', str(value.get('generation', '')))
            or not re.fullmatch(r'[a-f0-9]{64}', str(value.get('sha256', '')))):
        raise RuntimeError('pre_capture_receipt_invalid')
    archive_root = canonical(value['archiveRoot'])
    if not any(canonical(item['path']) == archive_root for item in config['archives']):
        raise RuntimeError('pre_capture_archive_not_in_backup')
    stored = json.loads(private_file(archive_root / 'CURRENT.json').read_text(encoding='utf-8'))
    if stored != value: raise RuntimeError('pre_capture_receipt_not_current')
    snapshot = canonical(archive_root / value['generation'] / 'snapshot.tar.gz')
    if digest(snapshot) != value['sha256']: raise RuntimeError('pre_capture_snapshot_changed')
    if not parsed_utc(value['snapshotStartedAt']) <= parsed_utc(value['snapshotCompletedAt']) <= dt.datetime.now(dt.timezone.utc):
        raise RuntimeError('pre_capture_time_invalid')
    # Only fixed metadata enters the central manifest, never arbitrary output.
    return {key: value[key] for key in ('kind', 'account', 'generation', 'sha256',
        'consistency', 'sameInstantAsCentral', 'snapshotStartedAt', 'snapshotCompletedAt')}


@contextlib.contextmanager
def exclusive_lock(filename):
    import fcntl
    path = Path(filename)
    if not path.is_absolute() or path.is_symlink() or path.parent.resolve() != path.parent:
        raise RuntimeError('invalid_lock_path')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def unit_state(unit):
    data = command(['systemctl', 'show', unit, '--property=ActiveState,SubState,MainPID,ExecMainStatus']).decode()
    return dict(line.split('=', 1) for line in data.splitlines() if '=' in line)


@handle_stop_signals(ignore=True)
def recover_writers(config):
    """Idempotently start only recorded units. Caller holds the deployment lock."""
    path = journal_path(config['shutdown_journal'])
    if not path.exists(): return
    validate_writers(config)
    journal = json.loads(path.read_text(encoding='utf-8'))
    pending = journal.get('pendingWriters')
    allowed = {writer['unit'] for writer in config['writers']}
    if (journal.get('version') != 1 or not RUN_RE.fullmatch(journal.get('runId', ''))
            or not isinstance(pending, list) or len(pending) > 32
            or any(not isinstance(unit, str) or unit not in allowed for unit in pending)
            or len(set(pending)) != len(pending)):
        raise RuntimeError('invalid_shutdown_journal')
    errors = []
    # Repeated TERM/INT must not interrupt the attempt to bring writers back.
    # SIGKILL still leaves the journal for ExecStopPost or the next invocation.
    with handle_stop_signals(ignore=True):
        for unit in reversed(pending[:]):
            try:
                command(['systemctl', 'start', unit], timeout=150)
                state = unit_state(unit)
                if state.get('ActiveState') != 'active' or int(state.get('MainPID', '0')) <= 0:
                    raise RuntimeError('writer_restart_failed')
                journal['pendingWriters'] = [item for item in journal['pendingWriters'] if item != unit]
                write_json(path, journal)
            except Exception:
                errors.append(unit)
        if not errors:
            path.unlink()
            fsync_directory(path.parent)
    if errors: raise RuntimeError('backup_writer_restart_failed')


@contextlib.contextmanager
def stopped_writers(config, run_id):
    if not isinstance(run_id, str) or not RUN_RE.fullmatch(run_id):
        raise RuntimeError('invalid_backup_run_id')
    path = journal_path(config['shutdown_journal'])
    if path.exists(): raise RuntimeError('unrecovered_shutdown_journal')
    writers = config['writers']
    validate_writers(config)
    journal = {'version': 1, 'runId': run_id, 'controllerPid': os.getpid(),
               'createdUtc': utc_now(), 'pendingWriters': []}
    evidence = []
    try:
        for writer in writers:
            before = unit_state(writer['unit'])
            if before.get('ActiveState') != 'active' or int(before.get('MainPID', '0')) <= 0:
                raise RuntimeError('writer_not_healthy_before_backup')
            pid = int(before['MainPID']); requested_at = int(time.time() * 1000)
            journal['pendingWriters'].append(writer['unit'])
            # Persist the intent before stopping: a kill between these two
            # operations is safe to recover by idempotently starting the unit.
            write_json(path, journal)
            # The application has a 120s drain budget; let systemd finish that
            # shutdown before treating a slow but clean writer as failed.
            command(['systemctl', 'stop', writer['unit']], timeout=180)
            after = unit_state(writer['unit'])
            if after.get('ActiveState') != 'inactive' or after.get('MainPID') != '0' or after.get('ExecMainStatus') != '0':
                raise RuntimeError('writer_failed_to_stop_cleanly')
            marker = private_file(Path(writer['checkpoint_dir']) / f'{pid}.json')
            proof = json.loads(marker.read_text())
            if proof.get('version') != 1 or proof.get('clean') is not True or proof.get('pid') != pid or proof.get('completedAt', 0) < requested_at:
                raise RuntimeError('clean_checkpoint_proof_missing')
            evidence.append({'unit': writer['unit'], 'checkpoint': proof})
        yield evidence
    finally:
        recover_writers(config)


def verify_sqlite(filename):
    uri = Path(filename).resolve().as_uri() + '?mode=ro'
    with contextlib.closing(sqlite3.connect(uri, uri=True)) as db:
        if db.execute('PRAGMA integrity_check').fetchone() != ('ok',):
            raise RuntimeError('sqlite_integrity_failed')
        if db.execute('PRAGMA foreign_key_check').fetchone() is not None:
            raise RuntimeError('sqlite_foreign_keys_failed')
        migrations = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'").fetchone()
        return [row[0] for row in db.execute('SELECT name FROM _migrations ORDER BY name')] if migrations else []


def snapshot_sqlite(source, dest):
    uri = Path(source).as_uri() + '?mode=ro'
    with contextlib.closing(sqlite3.connect(uri, uri=True)) as src, contextlib.closing(sqlite3.connect(dest)) as out:
        src.backup(out)
    return verify_sqlite(dest)


def sqlite_watermarks(filename, embedding):
    """Snapshot metadata only: no bodies, credentials, chat IDs, or inferred ACKs."""
    uri = Path(filename).resolve().as_uri() + '?mode=ro'
    result = {'version': 1, 'basis': 'frozen_sqlite', 'projections': 'ledger_not_remote_verification'}
    with contextlib.closing(sqlite3.connect(uri, uri=True)) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        def state_counts(table):
            return dict(db.execute(f'SELECT state,COUNT(*) FROM {table} GROUP BY state'))
        def identity_hash(sql):
            value = hashlib.sha256()
            for row in db.execute(sql):
                value.update(json.dumps(row, separators=(',', ':'), ensure_ascii=True).encode() + b'\n')
            return value.hexdigest()
        if 'cognitive_events' in tables:
            count, created, occurred = db.execute('SELECT COUNT(*),MAX(created_at),MAX(occurred_at) FROM cognitive_events').fetchone()
            result['cognitiveEvents'] = {'present': True, 'rows': count, 'maxCreatedAtSec': created,
                'maxOccurredAtSec': occurred, 'identitySha256': identity_hash('SELECT id,correlation_id,sequence FROM cognitive_events ORDER BY id'),
                'sequenceScope': 'per_correlation_not_global'}
        else: result['cognitiveEvents'] = {'present': False}
        if 'ingress_inbox' in tables:
            count, sequence, processed = db.execute('SELECT COUNT(*),MAX(sequence),MAX(processed_at_ms) FROM ingress_inbox').fetchone()
            result['ingressInbox'] = {'present': True, 'rows': count, 'maxSequence': sequence,
                'maxProcessedAtMs': processed, 'states': state_counts('ingress_inbox')}
        else: result['ingressInbox'] = {'present': False}
        if 'memory_sources' in tables:
            count, updated, tombstones = db.execute('SELECT COUNT(*),MAX(updated_at),COALESCE(SUM(tombstone),0) FROM memory_sources').fetchone()
            result['memorySources'] = {'present': True, 'rows': count, 'maxUpdatedAtMs': updated, 'tombstones': tombstones,
                'versionSetSha256': identity_hash('SELECT source_id,version,tombstone,event_id FROM memory_sources ORDER BY source_id')}
        else: result['memorySources'] = {'present': False}
        if 'memory_projection_jobs' in tables:
            last, done, unsettled = db.execute("SELECT MAX(id),MAX(CASE WHEN state='done' THEN id END),MIN(CASE WHEN state NOT IN ('done','superseded') THEN id END) FROM memory_projection_jobs").fetchone()
            result['memoryProjectionJobs'] = {'present': True, 'maxEnqueuedId': last, 'maxDoneId': done,
                'firstUnsettledId': unsettled, 'terminalPrefixId': (unsettled - 1 if unsettled else last),
                'states': state_counts('memory_projection_jobs')}
            if 'memory_sources' not in tables: raise RuntimeError('projection_without_authority_table')
            missing, incomplete = db.execute("""SELECT
                COALESCE(SUM(j.id IS NULL),0), COALESCE(SUM(j.id IS NOT NULL AND j.state!='done'),0)
                FROM memory_sources s LEFT JOIN memory_projection_jobs j ON j.source_id=s.source_id
                AND j.version=s.version AND j.model=? AND j.collection=?""",
                (embedding['model'], embedding['collection'])).fetchone()
            result['currentProjectionRoute'] = {'model': embedding['model'], 'collection': embedding['collection'],
                'missingCurrentVersionJobs': missing, 'unfinishedCurrentVersionJobs': incomplete}
        else: result['memoryProjectionJobs'] = {'present': False}
        for table, label in [('memory_source_events', 'memorySourceEvents'), ('memory_retractions', 'memoryRetractions')]:
            result[label] = {'present': True, 'rows': db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]} if table in tables else {'present': False}
    return result


def archive_tree(source, target, exclude=(), compress=True):
    root = canonical(source)
    excludes = {str(Path(p).as_posix()).strip('/') for p in exclude}
    with tarfile.open(target, 'w:gz' if compress else 'w', **({'compresslevel': 3} if compress else {})) as bundle:
        paths = [root] if root.is_file() else sorted(root.rglob('*'))
        for path in paths:
            relative = Path(root.name) if root.is_file() else path.relative_to(root)
            name = relative.as_posix()
            if any(name == p or name.startswith(p + '/') for p in excludes): continue
            if path.is_symlink(): raise RuntimeError('archive_symlink_refused')
            if path.is_file(): bundle.add(path, arcname=name, recursive=False)
            elif not path.is_dir(): raise RuntimeError('archive_special_file_refused')


def compress_archive(source):
    # Source is the immutable, quiesced tar, never the restarted live tree.
    source = canonical(source)
    target = source.with_name(source.name + '.gz')
    temporary = target.with_name(target.name + '.pending')
    try:
        with source.open('rb') as original, temporary.open('xb') as output:
            with gzip.GzipFile(filename='', mode='wb', fileobj=output, compresslevel=3, mtime=0) as compressed:
                shutil.copyfileobj(original, compressed, 1024 * 1024)
            output.flush(); os.fsync(output.fileno())
        temporary.replace(target); fsync_directory(source.parent)
        source.unlink(); fsync_directory(source.parent)
    finally:
        temporary.unlink(missing_ok=True)
    return target


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('qdrant_redirect_refused')


def qdrant_request(config, endpoint, method='GET', output=None, data=None):
    base = config['url'].rstrip('/')
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError('invalid_qdrant_url')
    if not endpoint.startswith('/') or endpoint.startswith('//') or method not in ('GET', 'POST', 'DELETE'):
        raise RuntimeError('invalid_qdrant_request')
    headers = {}
    if config.get('api_key_file'):
        headers['api-key'] = private_file(config['api_key_file']).read_text().strip()
    if data is not None:
        if method != 'POST': raise RuntimeError('invalid_qdrant_request_body')
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(base + endpoint, headers=headers, method=method,
                                     data=json.dumps(data).encode() if data is not None else b'' if method == 'POST' else None)
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=300) as response:
        if output:
            with Path(output).open('xb') as out: shutil.copyfileobj(response, out, 1024 * 1024)
            return None
        return json.load(response)


def snapshot_qdrant(config, destination):
    collections = qdrant_request(config, '/collections')['result']['collections']
    metadata = {'aliases': qdrant_request(config, '/aliases')['result'], 'collections': {}, 'exactCounts': {}}
    for item in collections:
        name = item['name']
        if not NAME_RE.fullmatch(name): raise RuntimeError('invalid_collection_name')
        prefix = '/collections/' + urllib.parse.quote(name, safe='')
        metadata['collections'][name] = qdrant_request(config, prefix)['result']
        count = qdrant_request(config, prefix + '/points/count', 'POST', data={'exact': True})['result']['count']
        if type(count) is not int or count < 0: raise RuntimeError('invalid_qdrant_exact_count')
        metadata['exactCounts'][name] = count
        snapshot = qdrant_request(config, prefix + '/snapshots', 'POST')['result']['name']
        if '/' in snapshot or '\\' in snapshot or snapshot.startswith('.'):
            raise RuntimeError('invalid_snapshot_name')
        endpoint = prefix + '/snapshots/' + urllib.parse.quote(snapshot, safe='')
        qdrant_request(config, endpoint, output=destination / f'qdrant-{name}.snapshot')
        # Remove only the exact temporary snapshot created by this invocation.
        qdrant_request(config, endpoint, 'DELETE')
    write_json(destination / 'qdrant-metadata.json', metadata)


def rclone_args(config):
    private_file(canonical(config['config_file']))
    return [config.get('binary', 'rclone'), '--config', config['config_file']]


def rclone_environment(config):
    password_file = private_file(canonical(config['config_password_file']))
    require_root_owner(password_file)
    if password_file.stat().st_size > 4096:
        raise RuntimeError('invalid_rclone_password_file')
    password = password_file.read_text(encoding='utf-8').rstrip('\r\n')
    if not password or '\x00' in password or '\n' in password or '\r' in password:
        raise RuntimeError('invalid_rclone_password_file')
    return {**os.environ, 'RCLONE_CONFIG_PASS': password}


def rclone_command(config, args, timeout=600):
    return command(rclone_args(config) + args, timeout=timeout, env=rclone_environment(config))


def validate_encrypted_drive(config):
    remote = config['remote']
    if not re.fullmatch(r'[a-zA-Z0-9_-]+:[a-zA-Z0-9_/-]+', remote) or '..' in remote.split('/'):
        raise RuntimeError('invalid_backup_remote')
    # Read only this dedicated config; never print its OAuth or crypt fields.
    data = json.loads(rclone_command(config, ['config', 'dump']))
    encrypted = data.get(remote.split(':', 1)[0], {})
    underlying = data.get(encrypted.get('remote', '').split(':', 1)[0], {})
    if encrypted.get('type') != 'crypt' or underlying.get('type') != 'drive':
        raise RuntimeError('google_drive_crypt_remote_required')
    if encrypted.get('filename_encryption', 'standard') != 'standard' or encrypted.get('directory_name_encryption', 'true') != 'true':
        raise RuntimeError('encrypted_names_required')


def verify_generation(directory):
    directory = canonical(directory)
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest.get('version') != 1 or not RUN_RE.fullmatch(manifest.get('runId', '')):
        raise RuntimeError('invalid_backup_manifest')
    validate_identity_metadata(manifest)
    seen = set()
    for record in manifest['files']:
        name = record['file']
        if not isinstance(name, str) or not MEMBER_RE.fullmatch(name) or name in seen: raise RuntimeError('invalid_manifest_member')
        seen.add(name); item = canonical(directory / name)
        if (not item.is_file() or not item.is_relative_to(directory) or type(record['bytes']) is not int
                or record['bytes'] < 0 or item.stat().st_size != record['bytes'] or digest(item) != record['sha256']):
            raise RuntimeError('backup_checksum_failed')
    if 'sqlite.db' not in seen or 'redis.rdb' not in seen or 'qdrant-metadata.json' not in seen:
        raise RuntimeError('required_component_missing')
    if any((directory / name).stat().st_size == 0 for name in ('sqlite.db', 'redis.rdb', 'qdrant-metadata.json')):
        raise RuntimeError('required_component_empty')
    metadata = json.loads((directory / 'qdrant-metadata.json').read_text(encoding='utf-8'))
    collections = metadata.get('collections') if isinstance(metadata, dict) else None
    if not isinstance(collections, dict) or not isinstance(metadata.get('aliases'), dict):
        raise RuntimeError('invalid_qdrant_metadata')
    if 'exactCounts' in metadata:
        counts = metadata['exactCounts']
        if (not isinstance(counts, dict) or set(counts) != set(collections)
                or any(type(count) is not int or count < 0 for count in counts.values())):
            raise RuntimeError('invalid_qdrant_exact_counts')
    expected = set()
    for name, info in collections.items():
        if not NAME_RE.fullmatch(name) or not isinstance(info, dict):
            raise RuntimeError('invalid_qdrant_collection_metadata')
        member = f'qdrant-{name}.snapshot'
        expected.add(member)
        if member not in seen or (directory / member).stat().st_size <= 0:
            raise RuntimeError('qdrant_collection_snapshot_missing')
    if {name for name in seen if name.startswith('qdrant-') and name.endswith('.snapshot')} != expected:
        raise RuntimeError('unexpected_qdrant_collection_snapshot')
    embedding = manifest['embedding']
    info = collections.get(embedding['collection'], {})
    vectors = info.get('config', {}).get('params', {}).get('vectors', {})
    if 'vector_name' in embedding and isinstance(vectors, dict):
        vectors = vectors.get(embedding['vector_name'], {})
    if not isinstance(vectors, dict) or type(vectors.get('size')) is not int or vectors['size'] != embedding['dimensions']:
        raise RuntimeError('embedding_collection_dimensions_mismatch')
    verify_sqlite(directory / 'sqlite.db')
    if 'watermarks' in manifest and manifest['watermarks'] != sqlite_watermarks(directory / 'sqlite.db', embedding):
        raise RuntimeError('backup_watermarks_mismatch')
    return manifest


def upload_generation(directory, config):
    validate_encrypted_drive(config)
    manifest = verify_generation(directory)
    target = config['remote'].rstrip('/') + '/' + manifest['runId']
    excludes = ['--exclude', 'COMPLETE.json', '--exclude', 'COMPLETE.pending.json']
    rclone_command(config, ['copy', str(directory), target, *excludes], timeout=7200)
    rclone_command(config, ['cryptcheck', str(directory), target, *excludes], timeout=7200)
    if rclone_command(config, ['cat', target + '/manifest.json']) != (directory / 'manifest.json').read_bytes():
        raise RuntimeError('remote_manifest_readback_failed')
    receipt = {'version': 2, 'runId': manifest['runId'], 'uploadVerifiedAt': utc_now(),
               'manifestSha256': digest(directory / 'manifest.json'), 'restored': False}
    pending = directory / 'COMPLETE.pending.json'
    write_json(pending, receipt)
    try:
        rclone_command(config, ['copyto', str(pending), target + '/COMPLETE.json'])
        if json.loads(rclone_command(config, ['cat', target + '/COMPLETE.json'])) != receipt:
            raise RuntimeError('remote_receipt_readback_failed')
        # Only this finalized marker may satisfy a scheduled day. A kill before
        # remote ACK leaves pending, which is deliberately not success evidence.
        pending.replace(directory / 'COMPLETE.json')
        fsync_directory(directory)
    finally:
        pending.unlink(missing_ok=True)
    return receipt


def retention_policy(config):
    policy = config.get('retention', {'enabled': False, **RETENTION})
    if (not isinstance(policy, dict) or type(policy.get('enabled')) is not bool
            or any(type(policy.get(key)) is not int or policy[key] != value for key, value in RETENTION.items())
            or set(policy) != {'enabled', *RETENTION}):
        raise RuntimeError('retention_policy_requires_14_days_8_weeks_12_months')
    return policy


def remote_generation(drive, run_id, now):
    """Only finalized generations of this controller qualify, never partial uploads."""
    if not RUN_RE.fullmatch(run_id): return None
    target = drive['remote'].rstrip('/') + '/' + run_id
    inventory = json.loads(rclone_command(drive, ['lsjson', target, '--recursive']))
    if not isinstance(inventory, list) or len(inventory) > 514: return None
    members = {}
    for item in inventory:
        if (not isinstance(item, dict) or item.get('IsDir') is not False
                or not isinstance(item.get('Path'), str) or not MEMBER_RE.fullmatch(item['Path'])
                or item['Path'] != item.get('Name') or item['Path'] in members
                or type(item.get('Size')) is not int or item['Size'] < 0): return None
        members[item['Path']] = item['Size']
    if not {'manifest.json', 'COMPLETE.json'} <= members.keys(): return None
    if members['manifest.json'] > 1024 * 1024 or members['COMPLETE.json'] > 16384: return None
    raw_manifest = rclone_command(drive, ['cat', target + '/manifest.json'])
    raw_receipt = rclone_command(drive, ['cat', target + '/COMPLETE.json'])
    try:
        manifest, receipt = json.loads(raw_manifest), json.loads(raw_receipt)
        if (not isinstance(manifest, dict) or not isinstance(receipt, dict)
                or manifest.get('version') != 1 or manifest.get('producer') != PRODUCER
                or manifest.get('runId') != run_id or manifest.get('consistency') != 'application_quiesced'
                or manifest.get('watermarks', {}).get('version') != 1
                or receipt.get('version') != 2 or receipt.get('runId') != run_id
                or receipt.get('restored') is not False): return None
        validate_identity_metadata(manifest)
        created, verified = parsed_utc(manifest['createdUtc']), parsed_utc(receipt['uploadVerifiedAt'])
        if not created <= verified <= now: return None
        sha = hashlib.sha256(raw_manifest).hexdigest()
        if receipt.get('manifestSha256') != sha or members['manifest.json'] != len(raw_manifest) or members['COMPLETE.json'] != len(raw_receipt): return None
        if not isinstance(manifest.get('files'), list) or not 3 <= len(manifest['files']) <= 512: return None
        expected = {'manifest.json', 'COMPLETE.json'}
        for record in manifest['files']:
            name = record.get('file') if isinstance(record, dict) else None
            if (not isinstance(name, str) or not MEMBER_RE.fullmatch(name) or name in expected
                    or type(record.get('bytes')) is not int or record['bytes'] < 0
                    or not isinstance(record.get('sha256'), str) or not re.fullmatch('[a-f0-9]{64}', record['sha256'])
                    or members.get(name) != record['bytes']): return None
            if record['bytes'] == 0 and (name in ('sqlite.db', 'redis.rdb', 'qdrant-metadata.json')
                    or name.startswith('qdrant-') and name.endswith('.snapshot')): return None
            expected.add(name)
        if expected != members.keys() or not {'sqlite.db', 'redis.rdb', 'qdrant-metadata.json',
                'qdrant-' + manifest['embedding']['collection'] + '.snapshot'} <= expected: return None
        return {'runId': run_id, 'created': created, 'manifestSha256': sha,
                'receiptSha256': hashlib.sha256(raw_receipt).hexdigest(), 'members': members}
    except (ValueError, KeyError, TypeError, AttributeError, RuntimeError):
        return None


def retained_generations(generations, current_run_id, now):
    """Union of latest per logical day/ISO week/month, plus current and latest."""
    today = dt.date.fromisoformat(backup_logical_day(now))
    monday = today - dt.timedelta(days=today.weekday())
    retained, buckets = {current_run_id}, set()
    ordered = sorted(generations, key=lambda item: (item['created'], item['runId']), reverse=True)
    if ordered: retained.add(ordered[0]['runId'])
    for item in ordered:
        day = dt.date.fromisoformat(backup_logical_day(item['created']))
        week = day - dt.timedelta(days=day.weekday())
        ages = {'daily': (today - day).days, 'weekly': (monday - week).days // 7,
                'monthly': (today.year - day.year) * 12 + today.month - day.month}
        for period, age in ages.items():
            if 0 <= age < RETENTION[period] and (period, age) not in buckets:
                retained.add(item['runId']); buckets.add((period, age))
    return retained


def apply_retention(config, just_uploaded, now=None):
    if not retention_policy(config)['enabled']: return {'enabled': False, 'deleted': []}
    now = now if now is not None else dt.datetime.now(dt.timezone.utc)
    drive = config['drive']; validate_encrypted_drive(drive)
    # A dedicated non-root crypt prefix is required before any destructive call.
    prefix = drive['remote'].split(':', 1)[1]
    if not re.fullmatch(r'[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*', prefix):
        raise RuntimeError('retention_requires_dedicated_crypt_prefix')
    current = verify_generation(just_uploaded)
    marker = private_file(canonical(Path(just_uploaded) / 'COMPLETE.json'))
    require_root_owner(marker)
    receipt = json.loads(marker.read_text(encoding='utf-8'))
    remote_current = remote_generation(drive, current['runId'], now)
    if (not remote_current or receipt.get('runId') != current['runId'] or receipt.get('version') != 2
            or receipt.get('restored') is not False or receipt.get('manifestSha256') != digest(Path(just_uploaded) / 'manifest.json')
            or remote_current['manifestSha256'] != receipt['manifestSha256']
            or remote_current['receiptSha256'] != digest(marker)):
        raise RuntimeError('retention_requires_current_verified_upload')
    listing = json.loads(rclone_command(drive, ['lsjson', drive['remote'], '--dirs-only', '--max-depth', '1']))
    if not isinstance(listing, list) or len(listing) > 10000: raise RuntimeError('invalid_retention_listing')
    candidates, seen, ignored = [], set(), 0
    for item in listing:
        name = item.get('Name') if isinstance(item, dict) else None
        if (not isinstance(name, str) or not RUN_RE.fullmatch(name) or item.get('Path') != name or item.get('IsDir') is not True):
            ignored += 1; continue
        if name in seen: raise RuntimeError('ambiguous_retention_listing')
        seen.add(name)
        candidate = remote_current if name == current['runId'] else remote_generation(drive, name, now)
        if candidate: candidates.append(candidate)
        else: ignored += 1
    if current['runId'] not in seen: raise RuntimeError('current_upload_missing_from_listing')
    keep = retained_generations(candidates, current['runId'], now)
    remove = sorted((item for item in candidates if item['runId'] not in keep), key=lambda item: item['created'])
    if len(remove) > 1000: raise RuntimeError('retention_deletion_limit')
    deleted = []
    # No recursive purge: exact, validated files only; an unexpected new member
    # makes the final rmdir fail rather than destroying unrelated data.
    for item in remove:
        if remote_generation(drive, item['runId'], now) != item:
            raise RuntimeError('retention_generation_changed')
        target = drive['remote'] + '/' + item['runId']
        rclone_command(drive, ['deletefile', target + '/COMPLETE.json'])
        for name in sorted(item['members']):
            if name not in ('COMPLETE.json', 'manifest.json'):
                rclone_command(drive, ['deletefile', target + '/' + name])
        rclone_command(drive, ['deletefile', target + '/manifest.json'])
        rclone_command(drive, ['rmdir', target])
        deleted.append(item['runId'])
    return {'enabled': True, 'policy': RETENTION, 'kept': len(keep), 'ignored': ignored, 'deleted': deleted}


def success_receipt(value, now):
    if (not isinstance(value, dict) or value.get('version') != 2
            or not isinstance(value.get('runId'), str) or not RUN_RE.fullmatch(value['runId'])
            or not isinstance(value.get('manifestSha256'), str)
            or not re.fullmatch('[a-f0-9]{64}', value['manifestSha256']) or value.get('restored') is not False):
        return None
    try:
        verified = parsed_utc(value.get('uploadVerifiedAt'))
        day = backup_logical_day(verified)
        if verified > now or day != backup_logical_day(now): return None
        if 'logicalDay' in value and value['logicalDay'] != day: return None
        return {**value, 'logicalDay': day}
    except (ValueError, RuntimeError): return None


def read_success_receipt(path, now):
    try:
        private_file(canonical(path)); require_root_owner(path)
        return success_receipt(json.loads(Path(path).read_text(encoding='utf-8')), now)
    except (ValueError, OSError, RuntimeError): return None


def capture_if_due(config, now=None):
    observed = now if now is not None else dt.datetime.now(dt.timezone.utc)
    day = backup_logical_day(observed)
    receipt_path = journal_path(config['schedule_receipt'])
    if receipt_path == Path(config['shutdown_journal']):
        raise RuntimeError('schedule_and_shutdown_receipts_must_be_distinct')
    # Keep the hourly check, snapshot and upload under one independent lock;
    # the deployment lock is still held only during application quiescence.
    with exclusive_lock(receipt_path.with_suffix('.lock')):
        if journal_path(config['shutdown_journal']).exists():
            with exclusive_lock(config['lock_file']): recover_writers(config)
        receipt = read_success_receipt(receipt_path, observed) if receipt_path.exists() else None
        if not receipt:
            for generation in canonical(config['staging_root']).iterdir():
                if not RUN_RE.fullmatch(generation.name) or generation.is_symlink() or not generation.is_dir(): continue
                candidate = read_success_receipt(generation / 'COMPLETE.json', observed)
                if candidate and candidate['runId'] == generation.name:
                    try:
                        if candidate['manifestSha256'] != digest(canonical(generation / 'manifest.json')): continue
                    except (OSError, RuntimeError): continue
                    receipt = candidate
                    write_json(receipt_path, receipt)
                    break
        if receipt:
            return {'skipped': True, 'logicalDay': day, 'runId': receipt['runId']}
        generation = capture(config)
        completed = now if now is not None else dt.datetime.now(dt.timezone.utc)
        receipt = read_success_receipt(generation / 'COMPLETE.json', completed)
        if not receipt or receipt['runId'] != generation.name:
            raise RuntimeError('scheduled_capture_missing_verified_receipt')
        write_json(receipt_path, receipt)
        return {'skipped': False, 'logicalDay': receipt['logicalDay'], 'runId': receipt['runId']}


def capture(config, local_only=False):
    validate_identity_metadata(config)
    retention_policy(config)
    staging = canonical(config['staging_root'])
    if shutil.disk_usage(staging).free < config.get('min_free_bytes', 20 * 1024 ** 3):
        raise RuntimeError('backup_staging_space_low')
    if not local_only: validate_encrypted_drive(config['drive'])
    run_id = 'nyatbot-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:12]
    destination = staging / run_id
    destination.mkdir(mode=0o700)
    with exclusive_lock(config['lock_file']):
        recover_writers(config)
        verify_live_release(config)
        external_snapshot = run_pre_capture(config)
        with stopped_writers(config, run_id) as evidence:
            migrations = snapshot_sqlite(config['sqlite_path'], destination / 'sqlite.db')
            redis = config['redis']
            command([redis['binary'], '-h', redis.get('host', '127.0.0.1'), '-p', str(redis['port']), '--rdb', str(destination / 'redis.rdb')])
            snapshot_qdrant(config['qdrant'], destination)
            for item in config['archives']:
                archive_tree(item['path'], destination / (item['name'] + '.tar'), item.get('exclude', []), compress=False)
            manifest = {'version': 1, 'runId': run_id, 'createdUtc': utc_now(),
                        'producer': PRODUCER,
                        'consistency': 'application_quiesced', 'writers': evidence,
                        'migrations': migrations, 'release': config['release'],
                        'embedding': config['embedding'], 'files': []}
            if external_snapshot:
                manifest['consistencyScope'] = 'central_bot_writers_only'
                manifest['externalSnapshots'] = [external_snapshot]
    # No live source is read after writers restart. Compression and metadata
    # scans use only this invocation's quiesced copies, outside the deployment lock.
    for archive in sorted(destination.glob('*.tar')): compress_archive(archive)
    manifest['watermarks'] = sqlite_watermarks(destination / 'sqlite.db', config['embedding'])
    for item in sorted(destination.iterdir()):
        if item.is_file():
            # Windows flush requires a writable handle; these are our own
            # private snapshot copies, never the live source files.
            with item.open('rb+') as snapshot: os.fsync(snapshot.fileno())
            manifest['files'].append({'file': item.name, 'bytes': item.stat().st_size, 'sha256': digest(item)})
    write_json(destination / 'manifest.json', manifest)
    verify_generation(destination)
    if not local_only:
        upload_generation(destination, config['drive'])
        retention = apply_retention(config, destination)
        write_json(staging / ('retention-' + run_id + '.json'), retention)
    return destination


def restore_to_quarantine(source, destination, config):
    manifest = verify_generation(source)
    target = Path(destination)
    allowed = quarantine_root(config)
    if (target.exists() or target.is_symlink() or not target.is_absolute() or target.parent != allowed
            or not NAME_RE.fullmatch(target.name) or overlaps(target, canonical(source))):
        raise RuntimeError('restore_requires_new_isolated_directory')
    target.mkdir(mode=0o700)
    for record in manifest['files']:
        item = Path(source) / record['file']
        if item.name.endswith('.tar.gz'):
            extracted = target / item.name.removesuffix('.tar.gz'); extracted.mkdir(mode=0o700)
            with tarfile.open(item, 'r:gz') as archive:
                for member in archive.getmembers():
                    p = Path(member.name)
                    if p.is_absolute() or '..' in p.parts or '\\' in member.name or ':' in member.name or not (member.isfile() or member.isdir()):
                        raise RuntimeError('unsafe_restore_archive')
                archive.extractall(extracted, filter='data')
        else: shutil.copy2(item, target / item.name)
    verify_sqlite(target / 'sqlite.db')
    write_json(target / 'RESTORE_QUARANTINED.json', {'runId': manifest['runId'], 'verifiedUtc': utc_now(),
               'platformIO': 'disabled', 'servicesStarted': False,
               'pending': ['Redis isolated load', 'Qdrant isolated recovery', 'NyatDB open and scoped queries', 'unknown delivery reconciliation']})
    # No daemon, restored credential, queue or external message is ever started.
    return target


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('preflight')
    sub.add_parser('recover-writers')
    sub.add_parser('capture-if-due')
    take = sub.add_parser('capture'); take.add_argument('--local-only', action='store_true')
    up = sub.add_parser('upload'); up.add_argument('generation')
    verify = sub.add_parser('verify'); verify.add_argument('generation')
    restore = sub.add_parser('restore-quarantine'); restore.add_argument('generation'); restore.add_argument('destination')
    args = parser.parse_args()
    result = {}
    if args.action == 'verify': verify_generation(args.generation)
    elif args.action == 'recover-writers':
        if os.name != 'posix' or os.geteuid() != 0: raise RuntimeError('writer_control_requires_root')
        config = load_recovery_config(args.config)
        with exclusive_lock(config['lock_file']): recover_writers(config)
    else:
        config = load_config(args.config)
        if args.action == 'preflight': validate_encrypted_drive(config['drive'])
        elif args.action in ('capture', 'capture-if-due'):
            if os.name != 'posix' or os.geteuid() != 0: raise RuntimeError('writer_control_requires_root')
            if args.action == 'capture': capture(config, args.local_only)
            else: result = capture_if_due(config)
        elif args.action == 'upload': upload_generation(Path(args.generation), config['drive'])
        elif args.action == 'restore-quarantine': restore_to_quarantine(args.generation, args.destination, config)
    print(json.dumps({'action': args.action, 'status': 'skipped' if result.get('skipped') else 'succeeded', **result}))


if __name__ == '__main__':
    try:
        with handle_stop_signals(): main()
    except Exception as error:
        # Do not print tracebacks, config, response bodies or subprocess output.
        print(json.dumps({'status': 'failed', 'errorType': type(error).__name__,
                          'reason': str(error) if type(error) is RuntimeError else 'operation_failed'}), file=sys.stderr)
        raise SystemExit(1)
