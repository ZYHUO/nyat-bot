"""Local synthetic release payloads; no real service, platform or user state."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('release_controller', ROOT / 'scripts/release-controller.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
A, B, C = 'a' * 40, 'b' * 40, 'c' * 40


class FakeService:
    """Stateful single-writer service; a second start while running fails."""
    def __init__(self, cfg):
        self.cfg = cfg
        self.running = A
        self.pid = 101
        self.started = int(time.time() * 1000) - 1000
        self.events = []
        self.bad = set()
        self.write_checkpoint = True
        self.leftover = False

    def state(self):
        return {'ActiveState': 'active' if self.running else 'inactive',
                'MainPID': str(self.pid) if self.running else '0',
                'ControlGroup': '/test.service', 'KillMode': 'control-group', 'ExecMainStatus': '0'}

    def ready(self, expected):
        release.require(self.running == expected and expected not in self.bad, 'health_failed')
        return {'pid': self.pid, 'processStartedAt': self.started, 'releaseId': expected}

    def stop(self):
        self.events.append(('stop', self.running))
        if self.running and self.write_checkpoint:
            release.atomic_json(Path(self.cfg['checkpoint_dir']) / f'{self.pid}.json', {
                'version': 1, 'clean': True, 'pid': self.pid, 'processStartedAt': self.started,
                'completedAt': int(time.time() * 1000), 'storesClosed': ['sqlite', 'nyatdb', 'redis']})
        self.running = None

    def stopped(self, _cgroup):
        release.require(not self.running and not self.leftover, 'writer_not_stopped')

    def start(self):
        if self.running:
            raise AssertionError('second writer started')
        self.running = release.current_release(self.cfg)
        self.pid += 1
        self.started = int(time.time() * 1000)
        self.events.append(('start', self.running))

    def observe(self, expected):
        self.events.append(('observe', expected))
        self.ready(expected)


class ReleaseControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.cfg = {'release_root': str(self.root / 'releases'), 'control_dir': str(self.root / 'control'),
                    'result_dir': str(self.root / 'results'), 'request_dir': str(self.root / 'requests'),
                    'checkpoint_dir': str(self.root / 'checkpoints'), 'request_uid': os.getuid(),
                    'approved_releases': [A, B, C], 'lock_file': str(self.root / 'lock')}
        for key in ('release_root', 'control_dir', 'result_dir', 'request_dir', 'checkpoint_dir'):
            Path(self.cfg[key]).mkdir()
        # Payload/modes/IO are real. Root ownership alone is substituted so these
        # tests run as an ordinary CI user; separate tests exercise owner refusal.
        owner = release.require_owner
        self.owner_patch = patch.object(release, 'require_owner',
                                       side_effect=lambda info, uid: None if uid == 0 else owner(info, uid))
        self.owner_patch.start()
        self.make_release(A)
        self.make_release(B)
        release.select_release(self.cfg, A)
        self.driver = FakeService(self.cfg)
        self.controller = release.Controller(self.cfg, self.driver)
        self.state_data = self.root / 'retained-data'
        self.state_data.write_text('existing user state')

    def tearDown(self):
        self.owner_patch.stop()
        for path in self.root.rglob('*'):
            if path.is_dir() and not path.is_symlink():
                path.chmod(0o700)
        self.temp.cleanup()

    def make_release(self, revision, migration='CREATE TABLE example(id INTEGER);', contract='state-v1'):
        root = Path(self.cfg['release_root']) / revision
        root.mkdir()
        (root / 'dist').mkdir()
        (root / 'dist/index.js').write_text('// payload ' + revision)
        (root / 'migrations').mkdir()
        (root / 'migrations/0001.sql').write_text(migration)
        (root / '.env.example').write_text('PUBLIC_EXAMPLE=placeholder\n')
        release.atomic_json(root / 'build-provenance.json', {'version': 1, 'release': revision, 'branch': release.BRANCH})
        release.seal(self.cfg, revision, contract)
        return root

    def request(self, action, target=None, identity='d' * 32):
        value = {'version': 1, 'id': identity, 'action': action}
        if target is not None:
            value['release'] = target
        release.atomic_json(Path(self.cfg['request_dir']) / 'request.json', value)
        return Path(self.cfg['result_dir']) / (identity + '.json')

    def test_success_and_rollback_preserve_shared_state_and_release_payloads(self):
        self.controller.activate(B)
        self.assertEqual(release.current_release(self.cfg), B)
        self.assertEqual(self.driver.events[:3], [('stop', A), ('start', B), ('observe', B)])
        self.assertEqual(self.controller.target_for_rollback(), A)
        self.state_data.write_text('newly committed user state')
        self.controller.activate(self.controller.target_for_rollback())
        self.assertEqual(release.current_release(self.cfg), A)
        self.assertEqual(self.state_data.read_text(), 'newly committed user state')
        self.assertTrue((Path(self.cfg['release_root']) / B / 'dist/index.js').exists())
        self.assertFalse(self.controller.journal_path.exists())

    def test_failed_health_rolls_back_without_second_writer(self):
        self.driver.bad.add(B)
        with self.assertRaisesRegex(release.Refused, 'health_failed'):
            self.controller.activate(B)
        self.assertEqual(self.driver.running, A)
        self.assertEqual(release.current_release(self.cfg), A)
        self.assertEqual(self.driver.events, [('stop', A), ('start', B), ('observe', B),
                                              ('stop', B), ('start', A), ('observe', A)])

    def test_failed_candidate_and_failed_rollback_keep_recovery_journal(self):
        self.driver.bad.add(B)
        original_observe = self.driver.observe
        def fail_then_break_old(expected):
            if expected == B:
                self.driver.bad.add(A)
            original_observe(expected)
        self.driver.observe = fail_then_break_old
        with self.assertRaisesRegex(release.Refused, 'controller_recovery_required'):
            self.controller.activate(B)
        self.assertTrue(self.controller.journal_path.exists())
        self.driver.bad.clear()
        self.controller.recover()
        self.assertEqual(self.driver.running, A)
        self.assertFalse(self.controller.journal_path.exists())

    def test_immutable_payload_migration_and_state_contract_gates_before_stop(self):
        self.make_release(C, migration='CREATE TABLE changed(id INTEGER);')
        with self.assertRaisesRegex(release.Refused, 'migrations_changed'):
            self.controller.activate(C)
        self.assertEqual(self.driver.events, [])
        manifest = Path(self.cfg['release_root']) / B / release.MANIFEST
        manifest.chmod(0o644)
        value = json.loads(manifest.read_text())
        value['stateContract'] = 'state-v2'
        manifest.write_text(json.dumps(value))
        manifest.chmod(0o444)
        with self.assertRaisesRegex(release.Refused, 'state_contract_mismatch'):
            self.controller.activate(B)
        payload = Path(self.cfg['release_root']) / B / 'dist/index.js'
        payload.chmod(0o644)
        payload.write_text('tampered payload')
        payload.chmod(0o444)
        with self.assertRaisesRegex(release.Refused, 'release_digest_mismatch'):
            self.controller.activate(B)
        self.assertEqual(self.driver.events, [])

    def test_no_clean_checkpoint_refuses_candidate_and_resumes_original(self):
        self.driver.write_checkpoint = False
        with self.assertRaisesRegex(release.Refused, 'update_failed'):
            self.controller.activate(B)
        self.assertNotIn(('start', B), self.driver.events)
        self.assertEqual(self.driver.running, A)

    def test_stale_checkpoint_cannot_authorize_activation(self):
        original_stop = self.driver.stop
        def stale_stop():
            original_stop()
            checkpoint = Path(self.cfg['checkpoint_dir']) / f'{self.driver.pid}.json'
            value = json.loads(checkpoint.read_text())
            value['processStartedAt'] -= 1
            release.atomic_json(checkpoint, value)
        self.driver.stop = stale_stop
        with self.assertRaisesRegex(release.Refused, 'old_writer_not_clean'):
            self.controller.activate(B)
        self.assertNotIn(('start', B), self.driver.events)

    def test_uncertain_stop_never_selects_or_starts_candidate(self):
        self.driver.leftover = True
        with self.assertRaisesRegex(release.Refused, 'controller_recovery_required'):
            self.controller.activate(B)
        self.assertEqual(release.current_release(self.cfg), A)
        self.assertFalse(any(event[0] == 'start' for event in self.driver.events))
        self.assertTrue(self.controller.journal_path.exists())

    def test_killed_controller_recovered_by_new_instance(self):
        journal = {'version': 1, 'phase': 'activating', 'old': A, 'target': B,
                   'cgroup': '/test.service', 'previous': None}
        child = """
import importlib.util, json, os, signal, sys
spec = importlib.util.spec_from_file_location('controller', sys.argv[1])
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
cfg, journal = json.loads(sys.argv[2]), json.loads(sys.argv[3])
mod.atomic_json(mod.Path(cfg['control_dir']) / 'transition.json', journal)
mod.select_release(cfg, journal['target'])
os.kill(os.getpid(), signal.SIGKILL)
"""
        result = subprocess.run([sys.executable, '-c', child, str(ROOT / 'scripts/release-controller.py'),
                                 json.dumps(self.cfg), json.dumps(journal)], capture_output=True)
        self.assertEqual(result.returncode, -signal.SIGKILL)
        self.assertEqual(release.current_release(self.cfg), B)
        self.driver.running = B
        release.Controller(self.cfg, self.driver).recover()
        self.assertEqual(release.current_release(self.cfg), A)
        self.assertEqual(self.driver.running, A)

    def test_durable_commit_recovery_finishes_commit_without_flipping_back(self):
        release.atomic_json(self.controller.journal_path, {'version': 1, 'phase': 'committed',
                            'old': A, 'target': B})
        release.select_release(self.cfg, B)
        self.driver.running = B
        self.controller.recover()
        self.assertEqual(self.controller.target_for_rollback(), A)
        self.assertEqual(self.driver.events, [])

    def test_boot_recovery_selects_original_before_service_can_start(self):
        release.atomic_json(self.controller.journal_path, {'version': 1, 'phase': 'activating',
                            'old': A, 'target': B, 'cgroup': '/test.service'})
        release.select_release(self.cfg, B)
        with self.assertRaisesRegex(release.Refused, 'writer_not_stopped'):
            self.controller.recover(selection_only=True)
        self.driver.running = None
        self.controller.recover(selection_only=True)
        self.assertEqual(release.current_release(self.cfg), A)
        self.assertEqual(self.driver.events, [])

    def test_request_success_dedup_and_pinned_rollback_retry(self):
        result = self.request('activate', B)
        self.controller.consume_request()
        self.assertEqual(json.loads(result.read_text()), {'version': 1, 'id': 'd' * 32,
                         'status': 'succeeded', 'activeRelease': B, 'error': None})
        self.request('rollback', identity='e' * 32)
        self.controller.consume_request()
        self.assertEqual(release.current_release(self.cfg), A)
        # Redelivery of an identical rollback ID must not switch to B again.
        self.request('rollback', identity='e' * 32)
        count = len(self.driver.events)
        self.controller.consume_request()
        self.assertEqual(len(self.driver.events), count)
        release.atomic_json(self.controller.directory / 'pending-request.json',
                            {'version': 1, 'id': 'f' * 32, 'target': A})
        self.controller.consume_request()
        self.assertEqual(release.current_release(self.cfg), A)

    def test_no_previous_rollback_and_unapproved_target_receive_failed_receipt(self):
        result = self.request('rollback')
        self.controller.consume_request()
        self.assertEqual(json.loads(result.read_text())['error'], 'no_known_good_release')
        result = self.request('activate', '9' * 40, identity='e' * 32)
        self.controller.consume_request()
        self.assertEqual(json.loads(result.read_text())['error'], 'release_not_approved')

    def test_symlink_oversized_and_extra_key_request_rejected(self):
        incoming = Path(self.cfg['request_dir']) / 'request.json'
        incoming.symlink_to(self.state_data)
        self.controller.consume_request()
        self.assertEqual(self.state_data.read_text(), 'existing user state')
        incoming.write_text('x' * 4097)
        self.controller.consume_request()
        self.assertEqual(self.driver.events, [])
        self.request('activate', B)
        value = json.loads(incoming.read_text())
        value['shell'] = 'do something'
        release.atomic_json(incoming, value)
        self.controller.consume_request()
        self.assertEqual(self.driver.events, [])

    def test_real_flock_serializes_controllers_and_backup(self):
        with release.locked(self.cfg):
            with self.assertRaises(BlockingIOError):
                with release.locked(self.cfg):
                    self.fail('second controller acquired lock')

    def test_cgroup_descendant_must_be_empty_and_failed_query_is_closed(self):
        group = self.root / 'cgroups/test.service'
        (group / 'child').mkdir(parents=True)
        (group / 'cgroup.procs').write_text('')
        (group / 'child/cgroup.procs').write_text('123\n')
        service = release.Systemd(self.cfg)
        with patch.object(release, 'CGROUP_ROOT', group.parent), patch.object(service, 'state',
                return_value={'ActiveState': 'inactive', 'MainPID': '0'}):
            with self.assertRaisesRegex(release.Refused, 'writer_cgroup_not_empty'):
                service.stopped('/test.service')
            (group / 'child/cgroup.procs').write_text('')
            service.stopped('/test.service')
            with self.assertRaisesRegex(release.Refused, 'unknown_writer_cgroup'):
                service.stopped('../escape')

    def test_root_ownership_guard_is_real(self):
        self.owner_patch.stop()
        try:
            with self.assertRaisesRegex(release.Refused, 'invalid_control_file_owner'):
                release.require_owner(type('Info', (), {'st_uid': 999})(), 0)
        finally:
            self.owner_patch.start()

    def test_real_env_is_forbidden_but_tracked_example_is_sealable(self):
        self.assertEqual(release.verify_release(self.cfg, A)['release'], A)
        root = Path(self.cfg['release_root']) / A
        root.chmod(0o755)
        (root / '.env').write_text('PRIVATE_SYNTHETIC_CANARY')
        root.chmod(0o555)
        with self.assertRaisesRegex(release.Refused, 'release_contains_mutable_or_secret_files'):
            release.verify_release(self.cfg, A)

    def test_release_symlink_escape_is_rejected(self):
        root = Path(self.cfg['release_root']) / A
        root.chmod(0o755)
        (root / 'escape').symlink_to(self.state_data)
        root.chmod(0o555)
        with self.assertRaisesRegex(release.Refused, 'release_link_escapes'):
            release.verify_release(self.cfg, A)

    def test_health_http_checks_pid_release_and_process_stability(self):
        payload = {'status': 'ready', 'pid': 123, 'processStartedAt': 1, 'releaseId': A}
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        cfg = dict(self.cfg, health_url=f'http://127.0.0.1:{server.server_port}/ready')
        service = release.Systemd(cfg)
        state = {'ActiveState': 'active', 'MainPID': '123', 'KillMode': 'control-group'}
        try:
            with patch.object(service, 'state', return_value=state):
                self.assertEqual(service.ready(A)['pid'], 123)
                for key, value in [('pid', 999), ('releaseId', B), ('status', 'ok')]:
                    before = payload[key]
                    payload[key] = value
                    with self.assertRaisesRegex(release.Refused, 'health_failed'):
                        service.ready(A)
                    payload[key] = before
            with patch.object(service, 'state', side_effect=[state, dict(state, MainPID='456')]):
                with self.assertRaisesRegex(release.Refused, 'health_failed'):
                    service.ready(A)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_health_slow_drip_has_total_deadline(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                try:
                    for _ in range(30):
                        self.wfile.write(b' ')
                        self.wfile.flush()
                        time.sleep(0.05)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        service = release.Systemd(dict(self.cfg, health_url=f'http://127.0.0.1:{server.server_port}/ready'))
        state = {'ActiveState': 'active', 'MainPID': '123', 'KillMode': 'control-group'}
        try:
            started = time.monotonic()
            with patch.object(service, 'state', return_value=state), patch.object(release, 'PROBE_TIMEOUT_SECONDS', 0.2):
                with self.assertRaises(subprocess.TimeoutExpired):
                    service.ready(A)
            self.assertLess(time.monotonic() - started, 1.2)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_observation_rejects_restart_after_initial_readiness(self):
        service = release.Systemd(dict(self.cfg, startup_seconds=0.1, observe_seconds=0.1, poll_seconds=0.001))
        with patch.object(service, 'ready', side_effect=[{'pid': 1}, {'pid': 2}]):
            with self.assertRaisesRegex(release.Refused, 'health_process_changed'):
                service.observe(A)


if __name__ == '__main__':
    unittest.main()
