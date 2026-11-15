#!/usr/bin/env python3
"""Download a sealed cloud backup and load disposable data copies; never start a bot."""
import argparse
import contextlib
import datetime as dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import uuid

class DrillError(RuntimeError):
    """Static, non-content error code safe to include in the receipt."""


def fail(code):
    raise DrillError(code) from None


def trusted_runtime(filename, *, directory=False):
    original = Path(filename)
    correct_type = original.is_dir() if directory else original.is_file()
    if not original.is_absolute() or original.resolve(strict=True) != original or not correct_type:
        fail('runtime_path_untrusted')
    if os.name == 'posix':
        for path in (original, *original.parents):
            info = path.stat()
            if info.st_uid != 0 or info.st_mode & 0o022:
                fail('runtime_owner_or_parent_untrusted')
    return original


controller_path = Path(__file__).resolve().with_name('backup-controller.py')
if __name__ == '__main__':
    # Check before executing the adjacent helper, not after importing it.
    try:
        trusted_runtime(Path(__file__).absolute())
        trusted_runtime(controller_path)
    except (OSError, DrillError):
        print(json.dumps({'status': 'failed', 'phase': 'configuration', 'error': 'untrusted_restore_control_code'}))
        sys.exit(1)
spec = importlib.util.spec_from_file_location('restore_backup_controller', controller_path)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def clean_environment(home):
    environment = {'PATH': os.defpath, 'HOME': str(home), 'TMPDIR': str(home), 'LANG': 'C', 'LC_ALL': 'C'}
    if os.name == 'nt':  # Offline developer tests: Node's Windows RNG requires SystemRoot.
        environment.update({'SystemRoot': os.environ.get('SystemRoot', 'C:\\Windows'), 'TEMP': str(home), 'TMP': str(home)})
    return environment


def save_copy_failure_stderr(home, stderr):
    # This directory is the new root-private quarantine workdir. Never log the
    # command, its stdout (config dump contains credentials), or inherited env.
    # Exclusive/no-follow creation cannot overwrite an earlier diagnostic/link.
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(Path(home) / 'rclone-copy.stderr.log', flags, 0o600)
        with os.fdopen(descriptor, 'wb') as log:
            log.write((stderr or b'')[-1024 * 1024:])
    except OSError:
        fail('command_diagnostic_write_failed')


def execute(args, home, timeout=120, extra_env=None, copy_failure_log=False):
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                cwd=home, env={**clean_environment(home), **(extra_env or {})}, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        if copy_failure_log:
            save_copy_failure_stderr(home, error.stderr)
        fail('command_timeout')
    except OSError:
        fail('command_start_failed')
    if result.returncode:
        if copy_failure_log:
            save_copy_failure_stderr(home, result.stderr)
        fail('command_failed')
    if len(result.stdout) > 8 * 1024 * 1024:
        fail('command_result_too_large')
    return result.stdout


def rclone(config, args, home, timeout=300):
    # Inherited RCLONE_CONFIG_* cannot redirect a trusted, explicitly supplied config.
    password = backup.rclone_environment(config)['RCLONE_CONFIG_PASS']
    return execute(backup.rclone_args(config) + args, home, timeout, {'RCLONE_CONFIG_PASS': password},
                   copy_failure_log=bool(args and args[0] == 'copy'))


def validate_cloud(config, home):
    remote = config['remote']
    if not re.fullmatch(r'[a-zA-Z0-9_-]+:[a-zA-Z0-9_/-]+', remote) or '..' in remote.split('/'):
        fail('invalid_cloud_prefix')
    data = json.loads(rclone(config, ['config', 'dump'], home))
    crypt = data.get(remote.split(':')[0], {})
    underlying = data.get(crypt.get('remote', '').split(':')[0], {})
    if crypt.get('type') != 'crypt' or underlying.get('type') != 'drive':
        fail('encrypted_drive_required')
    if crypt.get('filename_encryption', 'standard') != 'standard' or crypt.get('directory_name_encryption', 'true') != 'true':
        fail('encrypted_names_required')


def download_generation(config, run_id, work):
    if not isinstance(run_id, str) or not backup.RUN_RE.fullmatch(run_id):
        fail('invalid_run_id')
    drive = config['drive']
    validate_cloud(drive, work)
    remote = drive['remote'].rstrip('/') + '/' + run_id
    raw_manifest = rclone(drive, ['cat', remote + '/manifest.json'], work)
    raw_seal = rclone(drive, ['cat', remote + '/COMPLETE.json'], work)
    if len(raw_manifest) > 1024 * 1024 or len(raw_seal) > 16384:
        fail('cloud_metadata_too_large')
    manifest, seal = json.loads(raw_manifest), json.loads(raw_seal)
    if (manifest.get('version') != 1 or manifest.get('runId') != run_id
            or manifest.get('producer') != backup.PRODUCER or manifest.get('consistency') != 'application_quiesced'
            or manifest.get('watermarks', {}).get('version') != 1
            or seal.get('version') != 2 or seal.get('runId') != run_id or seal.get('restored') is not False
            or seal.get('manifestSha256') != hashlib.sha256(raw_manifest).hexdigest()):
        fail('cloud_generation_unsealed')
    if not backup.parsed_utc(manifest['createdUtc']) <= backup.parsed_utc(seal['uploadVerifiedAt']) <= dt.datetime.now(dt.timezone.utc):
        fail('cloud_generation_time_invalid')
    files = manifest.get('files')
    if not isinstance(files, list) or not 3 <= len(files) <= 512:
        fail('cloud_inventory_invalid')
    expected = {'manifest.json', 'COMPLETE.json'}
    total = len(raw_manifest) + len(raw_seal)
    for record in files:
        name = record.get('file')
        if (not isinstance(name, str) or not backup.MEMBER_RE.fullmatch(name) or name in expected
                or type(record.get('bytes')) is not int or record['bytes'] < 0
                or not isinstance(record.get('sha256'), str) or not re.fullmatch('[a-f0-9]{64}', record['sha256'])):
            fail('cloud_inventory_invalid')
        expected.add(name)
        total += record['bytes']
    if total + 256 * 1024 * 1024 > shutil.disk_usage(work).free:
        fail('cloud_download_space_low')
    target = work / 'cloud'
    target.mkdir(mode=0o700)  # Must be new: never satisfy this stage using a local backup.
    rclone(drive, ['copy', remote, str(target), '--transfers', '1', '--checkers', '1',
                  '--tpslimit', '1', '--tpslimit-burst', '1', '--retries', '3',
                  '--low-level-retries', '10', '--retries-sleep', '30s'], work, timeout=7200)
    if {entry.name for entry in target.iterdir()} != expected:
        fail('downloaded_inventory_mismatch')
    if (target / 'manifest.json').read_bytes() != raw_manifest or (target / 'COMPLETE.json').read_bytes() != raw_seal:
        fail('cloud_generation_changed_during_download')
    verified = backup.verify_generation(target)
    if verified['runId'] != run_id:
        fail('downloaded_run_id_mismatch')
    return target, verified


def check_expansion_space(source, manifest, root):
    expanded = 0
    for record in manifest['files']:
        item = source / record['file']
        if item.name.endswith('.tar.gz'):
            with tarfile.open(item, 'r:gz') as archive:
                for member in archive:
                    path = Path(member.name)
                    if (path.is_absolute() or '..' in path.parts or '\\' in member.name or ':' in member.name
                            or not (member.isfile() or member.isdir())):
                        fail('unsafe_restore_archive')
                    # Extraction plus the extra NyatDB working copy. Other archive
                    # contents are never opened, but use the conservative full size.
                    expanded += member.size * 2
        else:
            expanded += record['bytes'] * 3  # Restored file plus isolated loader working copies.
        if expanded + 256 * 1024 * 1024 > shutil.disk_usage(root).free:
            fail('restore_expansion_space_low')


def sqlite_checks(target, manifest):
    migrations = backup.verify_sqlite(target / 'sqlite.db')
    if migrations != manifest.get('migrations'):
        fail('sqlite_migrations_mismatch')
    watermarks = backup.sqlite_watermarks(target / 'sqlite.db', manifest['embedding'])
    if watermarks != manifest.get('watermarks'):
        fail('sqlite_watermarks_mismatch')
    return {'integrity': True, 'foreignKeys': True, 'migrationCount': len(migrations),
            'migrationSha256': hashlib.sha256(json.dumps(migrations).encode()).hexdigest(),
            'manifestWatermarksMatched': True,
            'watermarksSha256': hashlib.sha256(json.dumps(watermarks, sort_keys=True).encode()).hexdigest()}


def validate_ports(config, ports):
    production = {int(config['redis']['port'])}
    qport = urllib.parse.urlparse(config['qdrant']['url']).port
    if qport:
        production.update((qport, qport + 1))
    if len(set(ports)) != len(ports) or any(type(port) is not int or not 1024 <= port <= 65535 or port in production for port in ports):
        fail('unsafe_restore_ports')
    # No service is contacted here. Binding proves the independent ports are free.
    with contextlib.ExitStack() as stack:
        for port in ports:
            sock = stack.enter_context(socket.socket())
            try:
                sock.bind(('127.0.0.1', port))
            except OSError:
                fail('restore_port_in_use')


def owns_listener(process, port):
    """Do not accept another daemon's health response in the free-port race."""
    if process.poll() is not None:
        return False
    inodes = set()
    for line in Path('/proc/net/tcp').read_text().splitlines()[1:]:
        fields = line.split()
        if len(fields) > 9 and fields[1] == f'0100007F:{port:04X}' and fields[3] == '0A':
            inodes.add('socket:[' + fields[9] + ']')
    return bool(inodes) and any(os.readlink(fd) in inodes for fd in Path(f'/proc/{process.pid}/fd').iterdir() if fd.is_symlink())


class Children:
    def __init__(self, home):
        self.home, self.children, self.logs = home, [], []

    def start(self, args, name):
        log = (self.home / (name + '.log')).open('xb')
        self.logs.append(log)
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 cwd=self.home, env=clean_environment(self.home))
        self.children.append(child)
        return child

    def close(self):
        stopped = True
        for child in reversed(self.children):
            try:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                stopped = False
        for log in self.logs:
            log.close()
        return stopped


def wait_ready(child, port, check, seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if child.poll() is not None:
            fail('restore_daemon_exited')
        try:
            if owns_listener(child, port):
                result = check()
                if result:
                    return result
        except (OSError, ValueError, DrillError):
            pass
        time.sleep(0.25)
    fail('restore_daemon_ready_timeout')


def redis_checks(args, target, work, children):
    directory = work / 'redis'
    directory.mkdir(mode=0o700)
    shutil.copyfile(target / 'redis.rdb', directory / 'dump.rdb')
    password = secrets.token_hex(32)
    config = directory / 'redis.conf'
    config.write_text('\n'.join(['bind 127.0.0.1', f'port {args.redis_port}', 'protected-mode yes',
        'daemonize no', 'appendonly no', 'save ""', 'rdbchecksum yes', 'databases 1024',
        f'requirepass {password}', 'dir ' + json.dumps(str(directory)), 'dbfilename dump.rdb',
        'logfile ""']) + '\n', encoding='utf-8')
    child = children.start([args.redis_server, str(config)], 'redis')
    def command(*command):
        return execute([args.redis_cli, '--raw', '-h', '127.0.0.1', '-p', str(args.redis_port), *command],
                       work, timeout=10, extra_env={'REDISCLI_AUTH': password}).decode('utf-8')
    def ready():
        return command('PING').strip() == 'PONG' and 'loading:0' in command('INFO', 'persistence')
    wait_ready(child, args.redis_port, ready, args.ready_timeout)
    if not owns_listener(child, args.redis_port):
        fail('redis_listener_ownership_lost')
    keyspace = command('INFO', 'keyspace')
    counts = [int(value) for value in re.findall(r'^db\d+:keys=(\d+),', keyspace, re.MULTILINE)]
    return {'loadedRdb': True, 'populatedDatabases': len(counts), 'keys': sum(counts),
            'countBasis': 'isolated_restored_instance_not_prebackup_live_comparison'}


def http_json(port, key, path, method='GET', data=None):
    request = urllib.request.Request(f'http://127.0.0.1:{port}' + path, method=method,
        data=None if data is None else json.dumps(data).encode(),
        headers={'api-key': key, 'Content-Type': 'application/json'})
    # Ignore proxy environment and never follow a redirect with the credential.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), backup.NoRedirect())
    with opener.open(request, timeout=10) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        fail('restore_http_result_too_large')
    return json.loads(raw)


MISSING_EXACT_COUNTS = object()


def compare_collections(expected, actual, counts, exact_counts=MISSING_EXACT_COUNTS):
    if set(expected) != set(actual) or set(counts) != set(expected):
        fail('qdrant_collection_set_mismatch')
    has_frozen_counts = exact_counts is not MISSING_EXACT_COUNTS
    if has_frozen_counts and (not isinstance(exact_counts, dict) or set(exact_counts) != set(expected)
            or any(type(value) is not int or value < 0 for value in exact_counts.values())):
        fail('qdrant_frozen_exact_counts_invalid')
    dimensions, total = [], 0
    for name, original in expected.items():
        old_params = original.get('config', {}).get('params', {})
        new_params = actual[name].get('config', {}).get('params', {})
        if old_params.get('vectors') != new_params.get('vectors') or old_params.get('sparse_vectors') != new_params.get('sparse_vectors'):
            fail('qdrant_vector_configuration_mismatch')
        if type(counts[name]) is not int or counts[name] < 0:
            fail('qdrant_exact_count_invalid')
        # CollectionInfo.points_count is approximate, even while writers are
        # stopped. Only compare the frozen CountRequest(exact=true) denominator.
        if has_frozen_counts and counts[name] != exact_counts[name]:
            fail('qdrant_points_mismatch')
        vectors = old_params.get('vectors', {})
        configs = [vectors] if 'size' in vectors else list(vectors.values())
        dimensions.extend(config['size'] for config in configs)
        total += counts[name]
    return {'collections': len(actual), 'denseDimensions': sorted(dimensions), 'points': total,
            'pointsMatched': True if has_frozen_counts else None,
            'pointsBasis': 'exact_restored_count_matches_frozen_exact_count' if has_frozen_counts
                           else 'isolated_exact_count_only_no_frozen_exact_count'}


def alias_set(value):
    aliases = value.get('aliases')
    if not isinstance(aliases, list):
        fail('qdrant_alias_metadata_invalid')
    result = set()
    for alias in aliases:
        if not all(isinstance(alias.get(key), str) and backup.NAME_RE.fullmatch(alias[key]) for key in ('alias_name', 'collection_name')):
            fail('qdrant_alias_metadata_invalid')
        result.add((alias['alias_name'], alias['collection_name']))
    if len(result) != len(aliases) or len({pair[0] for pair in result}) != len(result):
        fail('qdrant_alias_metadata_invalid')
    return result


def qdrant_snapshot_argument(snapshot, name):
    if ':' in str(snapshot):
        fail('qdrant_snapshot_path_invalid')
    return str(snapshot) + ':' + name


def qdrant_checks(args, target, work, children):
    metadata = json.loads((target / 'qdrant-metadata.json').read_text())
    key = secrets.token_hex(32)
    directory = work / 'qdrant'
    directory.mkdir(mode=0o700)
    config = directory / 'config.yaml'  # JSON is a YAML subset; use Qdrant's documented YAML loader.
    backup.write_json(config, {'storage': {'storage_path': str(directory / 'storage'), 'snapshots_path': str(directory / 'snapshots')},
        'service': {'host': '127.0.0.1', 'http_port': args.qdrant_port, 'grpc_port': args.qdrant_grpc_port, 'api_key': key, 'enable_cors': False},
        'cluster': {'enabled': False}, 'telemetry_disabled': True, 'log_level': 'WARN'})
    command = [args.qdrant, '--config-path', str(config)]
    for name in sorted(metadata['collections']):
        snapshot = target / ('qdrant-' + name + '.snapshot')
        command.extend(['--snapshot', qdrant_snapshot_argument(snapshot, name)])
    child = children.start(command, 'qdrant')
    def query(path, method='GET', data=None):
        if not owns_listener(child, args.qdrant_port):
            fail('qdrant_listener_ownership_lost')
        return http_json(args.qdrant_port, key, path, method, data)['result']
    wait_ready(child, args.qdrant_port, lambda: query('/collections'), args.ready_timeout)
    actual_names = {row['name'] for row in query('/collections')['collections']}
    if actual_names != set(metadata['collections']):
        fail('qdrant_collection_set_mismatch')
    actual, counts = {}, {}
    for name in sorted(actual_names):
        endpoint = '/collections/' + urllib.parse.quote(name, safe='')
        actual[name] = query(endpoint)
        counts[name] = query(endpoint + '/points/count', 'POST', {'exact': True})['count']
    result = compare_collections(metadata['collections'], actual, counts,
                                 metadata.get('exactCounts', MISSING_EXACT_COUNTS))
    expected = alias_set(metadata['aliases'])
    if any(collection not in actual_names for _, collection in expected):
        fail('qdrant_alias_target_missing')
    observed = alias_set(query('/aliases'))
    if not observed and expected:
        query('/collections/aliases', 'POST', {'actions': [{'create_alias': {'alias_name': alias, 'collection_name': name}}
                                                        for alias, name in sorted(expected)]})
        observed = alias_set(query('/aliases'))
    if observed != expected:
        fail('qdrant_aliases_mismatch')
    return {**result, 'aliases': len(observed), 'aliasesMatched': True}


def relative_copy(root, name):
    relative = Path(name)
    if relative.is_absolute() or '..' in relative.parts or '\\' in name or ':' in name or not relative.parts:
        fail('invalid_copy_relative_path')
    resolved = backup.canonical(root / relative)
    if not resolved.is_relative_to(root) or resolved == root:
        fail('copy_path_escaped')
    return resolved


def nyatdb_checks(args, target, work):
    database = relative_copy(target, args.nyatdb_relative)
    # The TS engine can repair WAL/checkpoint metadata: open only this extra copy.
    working = work / 'nyatdb'
    shutil.copytree(database, working)
    raw = execute([args.node, args.nyatdb_probe, str(working)], work, timeout=args.ready_timeout)
    result = json.loads(raw)
    if not isinstance(result, dict) or result.get('ok') is not True or result.get('emptyScopeChecked') is not True or set(result) != {
            'ok', 'pages', 'chats', 'recalls', 'indexed', 'sampledChats', 'sampledMessages', 'emptyScopeChecked'}:
        fail('nyatdb_probe_invalid')
    if any(type(result[key]) is not int or result[key] < 0 for key in ('pages', 'chats', 'recalls', 'indexed', 'sampledChats', 'sampledMessages')):
        fail('nyatdb_probe_invalid')
    return result


def require_linux_root():
    if os.name != 'posix' or os.geteuid() != 0:
        fail('linux_root_required')


def run_drill(args):
    # No private application .env is read; only the explicit backup control file.
    require_linux_root()
    trusted_runtime(args.config)
    config = backup.load_config(args.config)
    if Path(args.config).stat().st_mode & 0o777 != 0o600:
        fail('backup_config_must_be_0600')
    if not backup.RUN_RE.fullmatch(args.run_id):
        fail('invalid_run_id')
    quarantine = backup.quarantine_root(config)
    trusted_runtime(quarantine, directory=True)
    work = quarantine / ('drill-' + args.run_id + '-' + uuid.uuid4().hex[:8])
    work.mkdir(mode=0o700)
    target = quarantine / ('restored-' + args.run_id + '-' + uuid.uuid4().hex[:8])
    receipt = {'version': 1, 'runId': args.run_id, 'startedUtc': backup.utc_now(), 'source': 'remote_rclone_crypt',
               'platformIO': 'disabled', 'botStarted': False, 'status': 'running', 'stages': {}, 'phase': 'preflight'}
    children = Children(work)
    try:
        if not 10 <= args.ready_timeout <= 1800:
            fail('invalid_ready_timeout')
        validate_ports(config, [args.redis_port, args.qdrant_port, args.qdrant_grpc_port])
        for name in ('node', 'redis_server', 'redis_cli', 'qdrant', 'nyatdb_probe'):
            trusted_runtime(getattr(args, name))
        for key in ('binary', 'config_file', 'config_password_file'):
            trusted_runtime(config['drive'][key])
        receipt['phase'] = 'cloud_download'
        source, manifest = download_generation(config, args.run_id, work)
        receipt['stages']['cloud'] = {'sealed': True, 'files': len(manifest['files']),
            'bytes': sum(record['bytes'] for record in manifest['files']), 'manifestSha256': backup.digest(source / 'manifest.json')}
        receipt['phase'] = 'quarantine_restore'
        check_expansion_space(source, manifest, quarantine)
        backup.restore_to_quarantine(source, target, config)
        receipt['phase'] = 'sqlite'
        receipt['stages']['sqlite'] = sqlite_checks(target, manifest)
        receipt['phase'] = 'redis'
        receipt['stages']['redis'] = redis_checks(args, target, work, children)
        receipt['phase'] = 'qdrant'
        receipt['stages']['qdrant'] = qdrant_checks(args, target, work, children)
        receipt['phase'] = 'nyatdb'
        receipt['stages']['nyatdb'] = nyatdb_checks(args, target, work)
        receipt['status'], receipt['phase'] = 'passed', 'complete'
    except Exception as error:
        receipt['status'] = 'failed'
        receipt['error'] = str(error) if isinstance(error, DrillError) else 'restore_stage_failed'
    finally:
        with backup.handle_stop_signals(ignore=True):
            receipt['childrenStopped'] = children.close()
            if not receipt['childrenStopped']:
                receipt['status'], receipt['error'] = 'failed', 'owned_process_cleanup_failed'
            receipt['finishedUtc'] = backup.utc_now()
            backup.write_json(work / 'RESTORE_DRILL.json', receipt)
    # Kept private on the server; never delete historic copies or recovered data.
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--node', default='/opt/nyatbot-runtime/bin/node')
    parser.add_argument('--nyatdb-probe', default='/opt/nyatbot-backup/app/dist/restore-nyatdb-probe.mjs')
    parser.add_argument('--redis-server', default='/opt/nyatbot-redis/bin/redis-server')
    parser.add_argument('--redis-cli', default='/opt/nyatbot-redis/bin/redis-cli')
    parser.add_argument('--qdrant', default='/opt/nyatbot-qdrant/v1.18.1-musl/qdrant')
    parser.add_argument('--redis-port', type=int, default=26379)
    parser.add_argument('--qdrant-port', type=int, default=27333)
    parser.add_argument('--qdrant-grpc-port', type=int, default=27334)
    parser.add_argument('--nyatdb-relative', default='application-data/nyatdb')
    parser.add_argument('--ready-timeout', type=int, default=300)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        with backup.handle_stop_signals():
            receipt = run_drill(args)
    except Exception:
        receipt = {'version': 1, 'status': 'failed', 'phase': 'configuration', 'error': 'restore_configuration_rejected', 'platformIO': 'disabled'}
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
