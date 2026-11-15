#!/usr/bin/env python3
"""Opt-in, local single-authority release handoff. Python >= 3.10, Linux/systemd.

The controller lives outside releases, never builds code, reads secrets, restores
databases, or deletes releases. Only an operator can seal/approve a release.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid

SHA = re.compile(r'[a-f0-9]{40}')
REQUEST_ID = re.compile(r'[a-f0-9]{32}')
BRANCH = 'codex/onebot-qq'
MANIFEST = 'release-manifest.json'
CGROUP_ROOT = Path('/sys/fs/cgroup')
PROBE_TIMEOUT_SECONDS = 4
HTTP_PROBE = '''
import sys, urllib.request
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
with opener.open(sys.argv[1], timeout=3) as response:
    if response.status != 200:
        raise SystemExit(1)
    body = response.read(8193)
    if len(body) > 8192:
        raise SystemExit(1)
    sys.stdout.buffer.write(body)
'''


class Refused(RuntimeError):
    pass


def require(condition, code):
    if not condition:
        raise Refused(code)


def require_owner(info, uid):
    require(info.st_uid == uid, 'invalid_control_file_owner')


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path, value, mode=0o600):
    path = Path(path)
    tmp = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            json.dump(value, out, sort_keys=True)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
        sync_dir(path.parent)
    finally:
        tmp.unlink(missing_ok=True)


def read_json(path, limit=1024 * 1024, uid=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'r', encoding='utf-8') as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, 'invalid_control_file')
        if uid is not None:
            require_owner(info, uid)
        value = source.read(limit + 1)
        require(len(value) <= limit, 'invalid_control_file')
        return json.loads(value)


def canonical(path):
    value = Path(path)
    require(value.is_absolute() and value.resolve(strict=True) == value, 'unsafe_path')
    return value


def trusted(path, private=False):
    value = canonical(path)
    for item in (value, *value.parents):
        info = item.stat()
        require_owner(info, 0)
        require(not info.st_mode & 0o022, 'untrusted_control_path')
    if private:
        require(not value.stat().st_mode & 0o077, 'control_path_not_private')
    return value


def load_config(filename):
    require(os.geteuid() == 0, 'controller_requires_root')
    cfg = read_json(trusted(filename, private=True), 16384, 0)
    require(cfg.get('version') == 1 and cfg.get('enabled') is True, 'controller_not_enabled')
    require(cfg.get('branch') == BRANCH, 'wrong_release_branch')
    require(re.fullmatch(r'[a-zA-Z0-9_.-]+\.service', cfg.get('unit', '')), 'invalid_unit')
    for key in ('release_root', 'control_dir', 'result_dir'):
        trusted(cfg[key], private=key == 'control_dir')
    roots = [Path(cfg[key]) for key in ('release_root', 'control_dir', 'result_dir')]
    require(all(a != b and a not in b.parents and b not in a.parents
                for i, a in enumerate(roots) for b in roots[i + 1:]), 'overlapping_control_roots')
    request_dir = canonical(cfg['request_dir'])
    trusted(request_dir.parent)
    request_info = request_dir.stat()
    require(type(cfg['request_uid']) is int and cfg['request_uid'] > 0
            and request_info.st_uid == cfg['request_uid']
            and not request_info.st_mode & 0o077, 'unsafe_request_directory')
    require(request_info.st_dev == Path(cfg['control_dir']).stat().st_dev,
            'spool_requires_same_filesystem')
    require(all(request_dir != root and root not in request_dir.parents
                and request_dir not in root.parents for root in roots), 'overlapping_control_roots')
    checkpoint = canonical(cfg['checkpoint_dir'])
    require(checkpoint.is_dir(), 'invalid_checkpoint_directory')
    lock = Path(cfg['lock_file'])
    trusted(lock.parent)
    require(lock.is_absolute() and not lock.is_symlink(), 'unsafe_lock')
    parsed = urllib.parse.urlsplit(cfg['health_url'])
    require(parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', '::1')
            and parsed.port and parsed.path == '/ready' and not parsed.query
            and not parsed.fragment and not parsed.username and not parsed.password,
            'health_must_be_loopback_ready')
    approved = cfg.get('approved_releases')
    require(isinstance(approved, list) and approved
            and all(isinstance(item, str) and SHA.fullmatch(item) for item in approved),
            'invalid_release_approval')
    for key, low, high in (('startup_seconds', 1, 600), ('observe_seconds', 1, 600),
                           ('poll_seconds', 0.1, 5)):
        require(type(cfg.get(key)) in (int, float) and low <= cfg[key] <= high, 'invalid_health_timing')
    return cfg


def tree_digest(root, immutable=True):
    """Hash the entire payload, including link targets; never follow a link out."""
    digest = hashlib.sha256()
    migration = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if relative == MANIFEST:
            continue
        require(relative.split('/')[0] not in ('.git', '.env', 'data', 'var', 'logs')
                and (not path.name.startswith('.env') or relative == '.env.example'),
                'release_contains_mutable_or_secret_files')
        info = path.lstat()
        require_owner(info, 0)
        if path.is_symlink():
            require(path.resolve(strict=True).is_relative_to(root), 'release_link_escapes')
            content = b'link:' + os.readlink(path).encode()
        elif path.is_file():
            require(info.st_nlink == 1 and not info.st_mode & 0o6000, 'unsafe_release_file')
            if immutable:
                require(not info.st_mode & 0o222, 'release_is_writable')
            file_hash = hashlib.sha256()
            with path.open('rb') as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    file_hash.update(block)
            content = file_hash.digest()
        elif path.is_dir():
            if immutable:
                require(not info.st_mode & 0o222, 'release_is_writable')
            content = b'dir'
        else:
            raise Refused('unsafe_release_file')
        entry = relative.encode() + b'\0' + content + b'\0'
        digest.update(entry)
        # Conservative automatic rollback gate. The separately reviewed state
        # contract covers Redis/job/config/protocol formats beyond SQL/NyatDB.
        if relative.startswith(('migrations/', 'src/db/', 'src/nyatdb/',
                                'packages/nyatdb/', 'native/nyatdb/')):
            migration.update(entry)
    return digest.hexdigest(), migration.hexdigest()


def release_path(cfg, release):
    require(isinstance(release, str) and SHA.fullmatch(release), 'invalid_release')
    root = Path(cfg['release_root']) / release
    require(root.resolve(strict=True) == root and root.is_dir(), 'unsafe_release_path')
    require_owner(root.stat(), 0)
    return root


def seal(cfg, release, contract):
    """Operator-only, after copying a non-root build to the controlled release root."""
    require(re.fullmatch(r'[a-zA-Z0-9_.-]{1,80}', contract or ''), 'state_contract_required')
    root = release_path(cfg, release)
    require(not (root / MANIFEST).exists(), 'release_already_sealed')
    require((root / 'dist/index.js').is_file() and (root / 'migrations').is_dir(), 'release_not_built')
    provenance = read_json(root / 'build-provenance.json', 4096, 0)
    require(provenance == {'version': 1, 'release': release, 'branch': BRANCH}, 'build_provenance_mismatch')
    payload, migrations = tree_digest(root, immutable=False)
    for path in sorted(root.rglob('*'), reverse=True):
        if not path.is_symlink():
            path.chmod(0o555 if path.is_dir() or path.stat().st_mode & 0o111 else 0o444)
    atomic_json(root / MANIFEST, {'version': 1, 'release': release, 'branch': BRANCH,
                'stateContract': contract, 'payloadHash': payload, 'migrationHash': migrations}, 0o444)
    root.chmod(0o555)
    sync_dir(root)


def verify_release(cfg, release):
    require(release in cfg['approved_releases'], 'release_not_approved')
    root = release_path(cfg, release)
    require(not root.stat().st_mode & 0o222, 'release_is_writable')
    manifest = read_json(root / MANIFEST, 4096, 0)
    require(not (root / MANIFEST).stat().st_mode & 0o222, 'release_is_writable')
    require(manifest.get('version') == 1 and manifest.get('release') == release
            and manifest.get('branch') == BRANCH, 'invalid_release_manifest')
    payload, migrations = tree_digest(root)
    require(manifest.get('payloadHash') == payload and manifest.get('migrationHash') == migrations,
            'release_digest_mismatch')
    return manifest


def compatible(old, new):
    require(old.get('stateContract') and old['stateContract'] == new.get('stateContract'),
            'state_contract_mismatch')
    require(old['migrationHash'] == new['migrationHash'], 'migrations_changed')


def current_release(cfg):
    link = Path(cfg['release_root']) / 'current'
    require(link.is_symlink(), 'current_release_not_initialized')
    target = link.resolve(strict=True)
    require(target.parent == Path(cfg['release_root']) and SHA.fullmatch(target.name), 'unsafe_current_release')
    return target.name


def select_release(cfg, release):
    root = Path(cfg['release_root'])
    temporary = root / ('.current-' + uuid.uuid4().hex)
    temporary.symlink_to(release)
    os.replace(temporary, root / 'current')
    sync_dir(root)


class Systemd:
    def __init__(self, cfg):
        self.cfg = cfg

    def command(self, *args):
        # Fixed executable/argv, no shell and no command output in errors.
        result = subprocess.run(['/usr/bin/systemctl', *args, self.cfg['unit']],
                                capture_output=True, timeout=180 if args[0] in ('stop', 'start') else 10, check=False,
                                env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'})
        require(result.returncode == 0, 'service_command_failed')
        return result.stdout.decode()

    def state(self):
        output = self.command('show', '--property=ActiveState,MainPID,ControlGroup,KillMode,ExecMainStatus')
        return dict(line.split('=', 1) for line in output.splitlines() if '=' in line)

    def stop(self):
        self.command('stop')

    def start(self):
        self.command('start')

    def stopped(self, cgroup):
        state = self.state()
        require(state.get('ActiveState') in ('inactive', 'failed')
                and state.get('MainPID') == '0', 'writer_not_stopped')
        require(isinstance(cgroup, str) and cgroup.startswith('/') and '..' not in cgroup.split('/'),
                'unknown_writer_cgroup')
        root = CGROUP_ROOT / cgroup.lstrip('/')
        # A removed cgroup is empty. If present, include descendant workers.
        if root.exists():
            require((root / 'cgroup.procs').exists(), 'unknown_writer_cgroup')
            for procs in (root / 'cgroup.procs', *root.rglob('cgroup.procs')):
                require(not procs.read_text().strip(), 'writer_cgroup_not_empty')

    def ready(self, release):
        before = self.state()
        require(before.get('ActiveState') == 'active' and before.get('KillMode') == 'control-group',
                'old_writer_not_ready')
        # A socket timeout resets on every byte. Isolate the bounded-body probe
        # in a child with a total deadline so a slow-drip candidate cannot hold
        # the controller indefinitely. Timeout kills and waits for this child.
        response = subprocess.run([sys.executable, '-I', '-c', HTTP_PROBE, self.cfg['health_url']],
                                  capture_output=True, check=False, timeout=PROBE_TIMEOUT_SECONDS,
                                  env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        require(response.returncode == 0 and len(response.stdout) <= 8192, 'health_failed')
        value = json.loads(response.stdout)
        after = self.state()
        require(value.get('status') == 'ready' and type(value.get('pid')) is int
                and str(value['pid']) == before.get('MainPID') == after.get('MainPID')
                and value.get('releaseId') == release
                and type(value.get('processStartedAt')) in (int, float)
                and 0 < value['processStartedAt'] <= time.time() * 1000,
                'health_failed')
        return {key: value[key] for key in ('pid', 'processStartedAt', 'releaseId')}

    def observe(self, release):
        deadline = time.monotonic() + self.cfg['startup_seconds']
        while True:
            try:
                identity = self.ready(release)
                break
            except Exception:
                require(time.monotonic() < deadline, 'health_failed')
                time.sleep(self.cfg['poll_seconds'])
        deadline = time.monotonic() + self.cfg['observe_seconds']
        while time.monotonic() < deadline:
            time.sleep(self.cfg['poll_seconds'])
            require(self.ready(release) == identity, 'health_process_changed')


class Controller:
    def __init__(self, cfg, driver=None):
        self.cfg = cfg
        self.driver = driver or Systemd(cfg)
        self.directory = Path(cfg['control_dir'])
        self.journal_path = self.directory / 'transition.json'
        self.state_path = self.directory / 'state.json'

    def audit(self, action, **fields):
        # Events contain only release IDs and fixed codes, never subprocess/HTTP bodies.
        path = self.directory / 'audit.jsonl'
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(json.dumps({'time': int(time.time()), 'action': action, **fields}) + '\n')
            output.flush()
            os.fsync(output.fileno())

    def clean_old(self, journal):
        identity = journal['identity']
        require(self.driver.state().get('ExecMainStatus') == '0', 'old_writer_not_clean')
        proof = read_json(Path(self.cfg['checkpoint_dir']) / f"{identity['pid']}.json", 4096)
        require(proof.get('version') == 1 and proof.get('clean') is True
                and proof.get('pid') == identity['pid']
                and proof.get('processStartedAt') == identity['processStartedAt']
                and type(proof.get('completedAt')) in (int, float)
                and journal['requestedAt'] <= proof['completedAt'] <= time.time() * 1000 + 1000
                and set(proof.get('storesClosed', [])) == {'sqlite', 'nyatdb', 'redis'},
                'old_writer_not_clean')

    def recover(self, selection_only=False):
        if not self.journal_path.exists():
            return
        journal = read_json(self.journal_path, 8192, 0)
        require(journal.get('version') == 1 and journal.get('phase') in ('stopping', 'activating', 'committed'),
                'invalid_transition_journal')
        old, target = journal['old'], journal['target']
        compatible(verify_release(self.cfg, old), verify_release(self.cfg, target))
        require(current_release(self.cfg) in (old, target), 'current_release_drift')
        if journal['phase'] == 'committed':
            require(current_release(self.cfg) == target, 'current_release_drift')
            atomic_json(self.state_path, {'version': 1, 'active': target, 'previous': old})
        else:
            # An interrupted switch is uncommitted: stop any candidate, prove all
            # processes gone, and resume the original. No DB snapshot is restored.
            if not selection_only:
                self.driver.stop()
            self.driver.stopped(journal['cgroup'])
            select_release(self.cfg, old)
            if not selection_only:
                self.driver.start()
                self.driver.observe(old)
            atomic_json(self.state_path, {'version': 1, 'active': old, 'previous': journal.get('previous')})
            self.audit('boot_selection_recovered' if selection_only else 'recovered', active=old, rejected=target)
        self.journal_path.unlink()
        sync_dir(self.directory)

    def target_for_rollback(self):
        require(self.state_path.exists(), 'no_known_good_release')
        state = read_json(self.state_path, 4096, 0)
        require(state.get('version') == 1 and state.get('active') == current_release(self.cfg), 'current_release_drift')
        require(isinstance(state.get('previous'), str) and SHA.fullmatch(state['previous']), 'no_known_good_release')
        return state['previous']

    def activate(self, target):
        require(not self.journal_path.exists(), 'controller_recovery_required')
        old = current_release(self.cfg)
        compatible(verify_release(self.cfg, old), verify_release(self.cfg, target))
        if old == target:
            self.driver.ready(old)
            return
        identity = self.driver.ready(old)
        state = self.driver.state()
        require(state.get('MainPID') == str(identity['pid']) and state.get('ControlGroup'), 'old_writer_not_ready')
        previous = None
        if self.state_path.exists():
            saved = read_json(self.state_path, 4096, 0)
            require(saved.get('active') == old, 'current_release_drift')
            previous = saved.get('previous')
        journal = {'version': 1, 'phase': 'stopping', 'old': old, 'target': target,
                   'identity': identity, 'cgroup': state['ControlGroup'], 'previous': previous,
                   'requestedAt': int(time.time() * 1000)}
        self.audit('activation_requested', old=old, target=target)
        atomic_json(self.journal_path, journal)
        try:
            self.driver.stop()
            self.driver.stopped(journal['cgroup'])
            self.clean_old(journal)
            journal['phase'] = 'activating'
            atomic_json(self.journal_path, journal)
            select_release(self.cfg, target)
            self.driver.start()
            self.driver.observe(target)
            # Commit intent first; recover completes this durable decision even
            # if killed between the state replacement and journal removal.
            journal['phase'] = 'committed'
            atomic_json(self.journal_path, journal)
            atomic_json(self.state_path, {'version': 1, 'active': target, 'previous': old})
            self.journal_path.unlink()
            sync_dir(self.directory)
            self.audit('activated', old=old, active=target)
        except Exception as error:
            try:
                self.recover()
            except Exception:
                self.audit('recovery_required', old=old, target=target)
                raise Refused('controller_recovery_required') from None
            raise Refused(str(error) if isinstance(error, Refused) else 'update_failed') from None

    def consume_request(self):
        pending = self.directory / 'pending-request.json'
        raw = self.directory / 'incoming-request.json'
        if not pending.exists():
            if not raw.exists() and not raw.is_symlink():
                incoming = Path(self.cfg['request_dir']) / 'request.json'
                try:
                    os.rename(incoming, raw)
                except FileNotFoundError:
                    return
                sync_dir(self.directory)
                sync_dir(incoming.parent)
            try:
                request = read_json(raw, 4096, self.cfg['request_uid'])
                require(isinstance(request, dict) and request.get('version') == 1
                        and isinstance(request.get('id'), str) and REQUEST_ID.fullmatch(request['id'])
                        and request.get('action') in ('activate', 'rollback'), 'invalid_request')
                allowed = {'version', 'id', 'action', 'release'} if request['action'] == 'activate' else {'version', 'id', 'action'}
                require(set(request) == allowed, 'invalid_request')
                if request['action'] == 'activate':
                    require(isinstance(request.get('release'), str) and SHA.fullmatch(request['release']), 'invalid_request')
                receipt = Path(self.cfg['result_dir']) / (request['id'] + '.json')
                if receipt.exists():
                    raw.unlink()
                    sync_dir(self.directory)
                    return
                target = request.get('release') if request['action'] == 'activate' else self.target_for_rollback()
                atomic_json(pending, {'version': 1, 'id': request['id'], 'target': target})
                self.audit('request_accepted', id=request['id'], requestedAction=request['action'], target=target)
            except Exception as error:
                # Invalid untrusted input is retained for diagnosis under a
                # generated name, never followed or used as a destination path.
                os.replace(raw, self.directory / ('rejected-' + uuid.uuid4().hex))
                code = str(error) if isinstance(error, Refused) else 'invalid_request'
                # Valid IDs receive a terminal receipt even if rollback has no
                # known-good predecessor. The rejected input is never replayed.
                if 'request' in locals() and isinstance(request, dict) and isinstance(request.get('id'), str) and REQUEST_ID.fullmatch(request['id']):
                    receipt = Path(self.cfg['result_dir']) / (request['id'] + '.json')
                    if not receipt.exists():
                        atomic_json(receipt, {'version': 1, 'id': request['id'], 'status': 'failed',
                                             'activeRelease': current_release(self.cfg), 'error': code}, 0o644)
                self.audit('request_rejected', error=code)
                return
            raw.unlink()
            sync_dir(self.directory)
        pending_value = read_json(pending, 4096, 0)
        require(pending_value.get('version') == 1 and REQUEST_ID.fullmatch(pending_value.get('id', '')),
                'invalid_pending_request')
        receipt = Path(self.cfg['result_dir']) / (pending_value['id'] + '.json')
        if receipt.exists():
            pending.unlink()
            sync_dir(self.directory)
            return
        result = {'version': 1, 'id': pending_value['id'], 'status': 'succeeded', 'error': None}
        try:
            self.activate(pending_value['target'])
        except Exception as error:
            result.update(status='failed', error=str(error) if isinstance(error, Refused) else 'update_failed')
        result['activeRelease'] = current_release(self.cfg)
        atomic_json(receipt, result, 0o644)
        pending.unlink()
        sync_dir(self.directory)
        require(not self.journal_path.exists(), 'controller_recovery_required')


@contextlib.contextmanager
def locked(cfg):
    fd = os.open(cfg['lock_file'], os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        require_owner(os.fstat(lock.fileno()), 0)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('action', choices=['seal', 'activate', 'rollback', 'recover', 'recover-selection', 'consume-request', 'status'])
    parser.add_argument('release', nargs='?')
    parser.add_argument('--state-contract')
    args = parser.parse_args()
    try:
        cfg = load_config(args.config)
        with locked(cfg):
            controller = Controller(cfg)
            if args.action == 'status':
                print(json.dumps({'activeRelease': current_release(cfg),
                                  'recoveryRequired': controller.journal_path.exists()}))
                return
            if args.action == 'seal':
                seal(cfg, args.release, args.state_contract)
                return
            controller.recover(selection_only=args.action == 'recover-selection')
            if args.action == 'activate':
                controller.activate(args.release)
            elif args.action == 'rollback':
                controller.activate(controller.target_for_rollback())
            elif args.action == 'consume-request':
                controller.consume_request()
    except Exception as error:
        print(str(error) if isinstance(error, Refused) else 'controller_failed', file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
