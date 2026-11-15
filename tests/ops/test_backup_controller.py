import importlib.util
import contextlib
import datetime as dt
import io
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import copy
import tarfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('backup_controller', ROOT / 'scripts/backup-controller.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        # Service ownership is tested separately; allow these real filesystem
        # and SQLite tests to run without root on developer/CI machines.
        self.root_owner = patch.object(backup, 'require_root_owner')
        self.root_owner.start()
        self.addCleanup(self.root_owner.stop)
        self.journal = self.root / 'writers-stopped.json'
        self.writer_config = {'shutdown_journal': str(self.journal),
                              'writers': [{'unit': 'nyatbot.service', 'checkpoint_dir': str(self.root)}]}
        self.run_id = 'nyatbot-20261114T160000Z-abcdef123456'

    def tearDown(self):
        self.temp.cleanup()

    def generation(self):
        directory = self.root / 'generation'; directory.mkdir()
        with contextlib.closing(sqlite3.connect(directory / 'sqlite.db')) as db:
            db.execute('CREATE TABLE evidence(content TEXT)')
            db.execute("INSERT INTO evidence VALUES ('PRIVATE_SYNTHETIC_CANARY')")
            db.commit()
        (directory / 'redis.rdb').write_bytes(b'synthetic-rdb-not-a-real-restore')
        backup.write_json(directory / 'qdrant-metadata.json', {
            'aliases': {'aliases': []}, 'collections': {
                'memory': {'config': {'params': {'vectors': {'size': 384, 'distance': 'Cosine'}}}}
            }})
        (directory / 'qdrant-memory.snapshot').write_bytes(b'synthetic-qdrant-snapshot')
        manifest = {'version': 1, 'runId': self.run_id, 'release': 'a' * 40,
                    'embedding': {'model': 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
                                  'dimensions': 384, 'collection': 'memory'}, 'files': []}
        for file in directory.iterdir():
            manifest['files'].append({'file': file.name, 'bytes': file.stat().st_size, 'sha256': backup.digest(file)})
        backup.write_json(directory / 'manifest.json', manifest)
        return directory

    def rehash(self, directory):
        manifest = json.loads((directory / 'manifest.json').read_text())
        manifest['files'] = [{'file': item.name, 'bytes': item.stat().st_size, 'sha256': backup.digest(item)}
                             for item in directory.iterdir() if item.name != 'manifest.json']
        backup.write_json(directory / 'manifest.json', manifest)

    def restore_config(self, generation):
        project = self.root / 'project'; project.mkdir(exist_ok=True)
        sqlite_path = project / 'live.db'; sqlite_path.touch()
        quarantine = self.root / 'quarantine'; quarantine.mkdir(exist_ok=True, mode=0o700)
        return {'project_root': str(project), 'sqlite_path': str(sqlite_path),
                'staging_root': str(generation), 'quarantine_root': str(quarantine), 'archives': []}

    def drive_config(self):
        config = self.root / 'rclone.conf'; config.write_text('ENCRYPTED_SYNTHETIC_CONFIG'); config.chmod(0o600)
        password = self.root / 'rclone-password'; password.write_text('PRIVATE_PASSWORD_CANARY\n'); password.chmod(0o600)
        return {'remote': 'encrypted:test', 'config_file': str(config), 'config_password_file': str(password)}

    def journal_value(self, units):
        backup.write_json(self.journal, {'version': 1, 'runId': self.run_id,
                                       'pendingWriters': units, 'controllerPid': 987})

    def test_real_sqlite_backup_integrity_and_tampering(self):
        generation = self.generation()
        self.assertEqual(backup.verify_generation(generation)['version'], 1)
        backup.snapshot_sqlite(generation / 'sqlite.db', self.root / 'copy.db')
        with contextlib.closing(sqlite3.connect(self.root / 'copy.db')) as db:
            self.assertEqual(db.execute('SELECT content FROM evidence').fetchone()[0], 'PRIVATE_SYNTHETIC_CANARY')
        (generation / 'sqlite.db').write_bytes(b'corrupt')
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            backup.verify_generation(generation)

    def test_restore_never_starts_a_service_and_refuses_existing_destination(self):
        generation = self.generation()
        config = self.restore_config(generation)
        with patch.object(backup, 'command') as command:
            target = backup.restore_to_quarantine(generation, self.root / 'quarantine' / 'restore', config)
            command.assert_not_called()
        receipt = json.loads((target / 'RESTORE_QUARANTINED.json').read_text())
        self.assertFalse(receipt['servicesStarted'])
        self.assertIn('Redis isolated load', receipt['pending'])
        with self.assertRaisesRegex(RuntimeError, 'isolated'):
            backup.restore_to_quarantine(generation, target, config)

    def test_failed_upload_has_no_complete_marker(self):
        generation = self.generation()
        with patch.object(backup, 'validate_encrypted_drive'), patch.object(backup, 'rclone_args', return_value=['rclone']), patch.object(backup, 'command', side_effect=RuntimeError('synthetic_upload_failure')):
            with self.assertRaisesRegex(RuntimeError, 'synthetic_upload_failure'):
                backup.upload_generation(generation, self.drive_config())
        self.assertFalse((generation / 'COMPLETE.json').exists())

    def test_success_requires_cryptcheck_and_manifest_and_receipt_readback(self):
        generation = self.generation(); calls = []
        def run(args, **_kwargs):
            calls.append(args)
            if 'cat' in args:
                return (generation / ('COMPLETE.pending.json' if args[-1].endswith('COMPLETE.json') else 'manifest.json')).read_bytes()
            return b''
        with patch.object(backup, 'validate_encrypted_drive'), patch.object(backup, 'rclone_args', return_value=['rclone']), patch.object(backup, 'command', side_effect=run):
            result = backup.upload_generation(generation, self.drive_config())
        self.assertFalse(result['restored'])
        self.assertTrue(any('cryptcheck' in args for args in calls))
        self.assertLess(next(i for i, args in enumerate(calls) if 'cryptcheck' in args), next(i for i, args in enumerate(calls) if 'copyto' in args))

    def test_writer_is_restarted_when_checkpoint_proof_is_missing(self):
        states = iter([{'ActiveState': 'active', 'MainPID': '123'}, {'ActiveState': 'inactive', 'MainPID': '0', 'ExecMainStatus': '0'}, {'ActiveState': 'active', 'MainPID': '124'}])
        with patch.object(backup, 'unit_state', side_effect=lambda _: next(states)), patch.object(backup, 'command') as command:
            with self.assertRaises(RuntimeError):
                with backup.stopped_writers(self.writer_config, self.run_id):
                    self.fail('unproven checkpoint accepted')
            self.assertIn(unittest.mock.call(['systemctl', 'start', 'nyatbot.service'], timeout=150), command.call_args_list)
            self.assertFalse(self.journal.exists())

    def test_successful_stop_checks_fresh_pid_bound_evidence_and_always_restarts(self):
        marker = self.root / '123.json'
        states = iter([{'ActiveState': 'active', 'MainPID': '123'}, {'ActiveState': 'inactive', 'MainPID': '0', 'ExecMainStatus': '0'}, {'ActiveState': 'active', 'MainPID': '124'}])
        def command(args, **_kwargs):
            if 'stop' in args:
                self.assertEqual(json.loads(self.journal.read_text())['pendingWriters'], ['nyatbot.service'])
                backup.write_json(marker, {'version': 1, 'clean': True, 'pid': 123, 'completedAt': int(time.time() * 1000)})
                marker.chmod(0o600)
            return b''
        with patch.object(backup, 'unit_state', side_effect=lambda _: next(states)), patch.object(backup, 'command', side_effect=command) as execute:
            with backup.stopped_writers(self.writer_config, self.run_id) as proof:
                self.assertEqual(proof[0]['checkpoint']['pid'], 123)
            self.assertTrue(any('start' in call.args[0] for call in execute.call_args_list))
        self.assertFalse(self.journal.exists())

    def test_term_and_int_run_recovery_from_stop_without_capture(self):
        for stop_signal in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=stop_signal):
                started = []
                def execute(args, **_kwargs):
                    if 'stop' in args:
                        self.assertTrue(self.journal.exists())
                        signal.raise_signal(stop_signal)
                    else:
                        started.append(args[-1])
                        # A repeated TERM during recovery cannot abort recovery.
                        signal.raise_signal(signal.SIGTERM)
                    return b''
                with backup.handle_stop_signals(), patch.object(backup, 'command', side_effect=execute), patch.object(backup, 'unit_state', return_value={'ActiveState': 'active', 'MainPID': '123'}):
                    with self.assertRaises(backup.BackupInterrupted):
                        with backup.stopped_writers(self.writer_config, self.run_id):
                            self.fail('interrupted capture must not proceed')
                self.assertEqual(started, ['nyatbot.service'])
                self.assertFalse(self.journal.exists())

    def test_kill_leaves_durable_journal_recoverable_by_a_new_controller(self):
        # This subprocess dies with os._exit: Python finally cannot execute.
        # A new controller must use the real on-disk journal, not process memory.
        code = '''
import importlib.util, json, os, pathlib, sys
spec = importlib.util.spec_from_file_location('backup', sys.argv[1])
backup = importlib.util.module_from_spec(spec); spec.loader.exec_module(backup)
backup.require_root_owner = lambda path: None
config = json.loads(sys.argv[2])
backup.unit_state = lambda unit: {'ActiveState': 'active', 'MainPID': '123'}
def command(args, **kwargs):
    if 'stop' in args: os._exit(77)
    raise RuntimeError('unexpected_recovery_before_kill')
backup.command = command
with backup.stopped_writers(config, sys.argv[3]): pass
'''
        killed = subprocess.run([sys.executable, '-c', code, str(ROOT / 'scripts/backup-controller.py'), json.dumps(self.writer_config), self.run_id], capture_output=True, check=False)
        self.assertEqual(killed.returncode, 77, killed.stderr.decode())
        self.assertEqual(json.loads(self.journal.read_text())['pendingWriters'], ['nyatbot.service'])
        if os.name == 'posix': self.assertEqual(self.journal.stat().st_mode & 0o777, 0o600)
        with patch.object(backup, 'command') as execute, patch.object(backup, 'unit_state', return_value={'ActiveState': 'active', 'MainPID': '456'}):
            backup.recover_writers(self.writer_config)
            backup.recover_writers(self.writer_config)
        execute.assert_called_once_with(['systemctl', 'start', 'nyatbot.service'], timeout=150)
        self.assertFalse(self.journal.exists())

    def test_failed_restart_remains_journaled_while_other_units_recover(self):
        self.writer_config['writers'].append({'unit': 'journal.service', 'checkpoint_dir': str(self.root)})
        self.journal_value(['nyatbot.service', 'journal.service'])
        calls = []
        def execute(args, **_kwargs):
            calls.append(args[-1])
            if args[-1] == 'journal.service': raise RuntimeError('synthetic_start_failed')
        with patch.object(backup, 'command', side_effect=execute), patch.object(backup, 'unit_state', return_value={'ActiveState': 'active', 'MainPID': '123'}):
            with self.assertRaisesRegex(RuntimeError, 'restart_failed'):
                backup.recover_writers(self.writer_config)
        self.assertEqual(calls, ['journal.service', 'nyatbot.service'])
        self.assertEqual(json.loads(self.journal.read_text())['pendingWriters'], ['journal.service'])
        with patch.object(backup, 'command') as execute, patch.object(backup, 'unit_state', return_value={'ActiveState': 'active', 'MainPID': '123'}):
            backup.recover_writers(self.writer_config)
        execute.assert_called_once_with(['systemctl', 'start', 'journal.service'], timeout=150)

    def test_unapproved_journal_unit_never_starts_and_recovery_needs_no_data_storage(self):
        self.journal_value(['unapproved.service'])
        config_path = self.root / 'recovery.json'
        backup.write_json(config_path, {**self.writer_config, 'lock_file': str(self.root / 'lock'),
                                       'sqlite_path': 'missing', 'release': 'invalid', 'archives': []})
        config = backup.load_recovery_config(config_path)
        with patch.object(backup, 'command') as execute:
            with self.assertRaisesRegex(RuntimeError, 'invalid_shutdown_journal'): backup.recover_writers(config)
        execute.assert_not_called()
        self.assertTrue(self.journal.exists())

    def test_journal_write_failure_never_stops_a_writer(self):
        with patch.object(backup, 'write_json', side_effect=OSError('synthetic_disk_full')), patch.object(backup, 'command') as execute, patch.object(backup, 'unit_state', return_value={'ActiveState': 'active', 'MainPID': '123'}):
            with self.assertRaises(OSError):
                with backup.stopped_writers(self.writer_config, self.run_id): pass
        execute.assert_not_called()

    def test_restore_rejects_production_outside_and_nested_paths(self):
        generation = self.generation(); config = self.restore_config(generation)
        for target in (self.root / 'project' / 'restore', self.root / 'elsewhere', self.root / 'quarantine' / 'nested' / 'restore'):
            with self.subTest(target=target):
                with self.assertRaisesRegex(RuntimeError, 'isolated'):
                    backup.restore_to_quarantine(generation, target, config)
                self.assertFalse(target.exists())
        config['quarantine_root'] = config['project_root']
        Path(config['quarantine_root']).chmod(0o700)
        with self.assertRaisesRegex(RuntimeError, 'disjoint'):
            backup.restore_to_quarantine(generation, self.root / 'project' / 'restore', config)

    def test_each_qdrant_collection_requires_an_inventoried_nonempty_snapshot(self):
        generation = self.generation()
        metadata = json.loads((generation / 'qdrant-metadata.json').read_text())
        metadata['collections']['second'] = metadata['collections']['memory']
        backup.write_json(generation / 'qdrant-metadata.json', metadata); self.rehash(generation)
        with self.assertRaisesRegex(RuntimeError, 'snapshot_missing'): backup.verify_generation(generation)
        (generation / 'qdrant-second.snapshot').write_bytes(b'')
        self.rehash(generation)
        with self.assertRaisesRegex(RuntimeError, 'snapshot_missing'): backup.verify_generation(generation)
        (generation / 'qdrant-second.snapshot').write_bytes(b'nonempty-snapshot'); self.rehash(generation)
        self.assertEqual(backup.verify_generation(generation)['version'], 1)
        (generation / 'qdrant-stray.snapshot').write_bytes(b'unknown'); self.rehash(generation)
        with self.assertRaisesRegex(RuntimeError, 'unexpected_qdrant'): backup.verify_generation(generation)

    def test_qdrant_capture_uses_exact_counts_before_snapshot_not_approximate_info(self):
        calls = []
        def request(_config, endpoint, method='GET', output=None, data=None):
            calls.append((endpoint, method, data))
            if output: Path(output).write_bytes(b'snapshot'); return
            if endpoint == '/collections': return {'result': {'collections': [{'name': 'memory'}]}}
            if endpoint == '/aliases': return {'result': {'aliases': []}}
            if endpoint.endswith('/points/count'): return {'result': {'count': 7}}
            if endpoint.endswith('/snapshots'): return {'result': {'name': 'fixed.snapshot'}}
            return {'result': {'points_count': 999}}
        with patch.object(backup, 'qdrant_request', side_effect=request): backup.snapshot_qdrant({}, self.root)
        metadata = json.loads((self.root / 'qdrant-metadata.json').read_text())
        self.assertEqual(metadata['exactCounts'], {'memory': 7})
        self.assertLess(calls.index(('/collections/memory/points/count', 'POST', {'exact': True})), calls.index(('/collections/memory/snapshots', 'POST', None)))

    def test_qdrant_exact_count_failure_cannot_fallback_to_approximate(self):
        def request(_config, endpoint, *args, **kwargs):
            if endpoint == '/collections': return {'result': {'collections': [{'name': 'memory'}]}}
            if endpoint == '/aliases': return {'result': {}}
            if endpoint.endswith('/points/count'): return {'result': {'count': True}}
            return {'result': {'points_count': 123}}
        with patch.object(backup, 'qdrant_request', side_effect=request) as call:
            with self.assertRaisesRegex(RuntimeError, 'invalid_qdrant_exact_count'): backup.snapshot_qdrant({}, self.root)
        self.assertFalse(any(args.args[1].endswith('/snapshots') for args in call.call_args_list))
        self.assertFalse((self.root / 'qdrant-metadata.json').exists())

    def test_partial_exact_count_metadata_is_rejected_but_legacy_remains_loadable(self):
        generation = self.generation(); backup.verify_generation(generation)
        filename = generation / 'qdrant-metadata.json'; metadata = json.loads(filename.read_text())
        for counts in ({}, {'memory': -1}, {'memory': True}, {'memory': 1, 'unknown': 2}):
            metadata['exactCounts'] = counts; backup.write_json(filename, metadata); self.rehash(generation)
            with self.assertRaisesRegex(RuntimeError, 'invalid_qdrant_exact_counts'): backup.verify_generation(generation)
        metadata['exactCounts'] = {'memory': 1}; backup.write_json(filename, metadata); self.rehash(generation)
        backup.verify_generation(generation)

    def test_placeholder_release_and_embedding_mismatch_refuse_backup(self):
        generation = self.generation()
        path = generation / 'manifest.json'; valid = json.loads(path.read_text())
        cases = [dict(valid, release='REPLACE_WITH_VERIFIED_COMMIT'),
                 dict(valid, release='a' * 7), dict(valid, release='0' * 40),
                 dict(valid, embedding={'model': 'REPLACE_WITH_RUNNING_MODEL', 'dimensions': 384, 'collection': 'memory'}),
                 dict(valid, embedding={**valid['embedding'], 'dimensions': True}),
                 dict(valid, embedding={**valid['embedding'], 'dimensions': 768}),
                 dict(valid, embedding={**valid['embedding'], 'collection': 'not_backed_up'})]
        for value in cases:
            with self.subTest(release=value['release'], embedding=value['embedding']):
                backup.write_json(path, value)
                with self.assertRaises(RuntimeError): backup.verify_generation(generation)
        with patch.object(backup, 'command') as execute:
            with self.assertRaisesRegex(RuntimeError, 'release_required'):
                backup.capture({'release': 'REPLACE_WITH_VERIFIED_COMMIT'}, local_only=True)
        execute.assert_not_called()

    def test_qdrant_redirect_never_sends_api_key_to_the_redirect_target(self):
        requests = []
        class Target(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(('target', self.headers.get('api-key')))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{}')
            def log_message(self, *_args): pass
        target = ThreadingHTTPServer(('127.0.0.1', 0), Target)
        class Origin(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(('origin', self.headers.get('api-key')))
                self.send_response(302)
                self.send_header('Location', f'http://127.0.0.1:{target.server_port}/steal')
                self.end_headers()
            def log_message(self, *_args): pass
        origin = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in (target, origin)]
        for thread in threads: thread.start()
        key = self.root / 'qdrant-key'; key.write_text('SYNTHETIC_API_KEY'); key.chmod(0o600)
        try:
            with self.assertRaisesRegex(RuntimeError, 'redirect_refused'):
                backup.qdrant_request({'url': f'http://127.0.0.1:{origin.server_port}', 'api_key_file': str(key)}, '/collections')
            self.assertEqual(requests, [('origin', 'SYNTHETIC_API_KEY')])
        finally:
            for server in (origin, target): server.shutdown(); server.server_close()
            for thread in threads: thread.join(timeout=2)

    def test_rclone_password_only_enters_child_environment_and_errors_are_redacted(self):
        config = self.drive_config(); stdout = io.StringIO(); stderr = io.StringIO()
        result = subprocess.CompletedProcess(args=['rclone'], returncode=1,
                                             stdout=b'PRIVATE_PASSWORD_CANARY', stderr=b'PRIVATE_PASSWORD_CANARY')
        with patch.object(backup.subprocess, 'run', return_value=result) as run, contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with self.assertRaisesRegex(RuntimeError, '^command_failed:rclone$') as error:
                backup.rclone_command(config, ['config', 'dump'])
        self.assertEqual(run.call_args.kwargs['env']['RCLONE_CONFIG_PASS'], 'PRIVATE_PASSWORD_CANARY')
        self.assertNotIn('PRIVATE_PASSWORD_CANARY', repr(run.call_args.args[0]))
        self.assertNotIn('PRIVATE_PASSWORD_CANARY', str(error.exception) + stdout.getvalue() + stderr.getvalue())
        self.assertNotEqual(os.environ.get('RCLONE_CONFIG_PASS'), 'PRIVATE_PASSWORD_CANARY')

    def test_atomic_json_replaces_old_stale_temp_without_broad_deletion(self):
        target = self.root / 'proof.json'
        stale = self.root / 'proof.json.tmp'; stale.write_text('stale')
        backup.write_json(target, {'step': 1}); backup.write_json(target, {'step': 2})
        self.assertEqual(json.loads(target.read_text()), {'step': 2})
        self.assertEqual(stale.read_text(), 'stale')
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ['proof.json', 'proof.json.tmp'])
        if os.name == 'posix': self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_service_includes_persistent_private_journal_and_recovery_hook(self):
        service = (ROOT / 'ops/nyatbot-backup.service').read_text()
        self.assertNotIn('StateDirectory=', service)
        self.assertIn('ExecStartPre=/usr/bin/install -d -m700 -o root -g root /var/lib/nyatbot-backup', service)
        self.assertIn('ExecStopPost=', service)
        self.assertIn('config.json recover-writers', service)
        self.assertIn('config.json capture-if-due', service)
        timer = (ROOT / 'ops/nyatbot-backup.timer').read_text()
        self.assertIn('OnCalendar=hourly', timer)
        self.assertIn('Persistent=true', timer)
        self.assertNotIn('20:00:00 UTC', timer)

    def schedule_config(self):
        staging = self.root / 'staging'; staging.mkdir(exist_ok=True, mode=0o700)
        return {**self.writer_config, 'staging_root': str(staging),
                'schedule_receipt': str(self.root / 'schedule.json'), 'lock_file': str(self.root / 'deploy.lock')}

    def finalized_generation(self, config, at, nonce='abcdef123456'):
        directory = self.generation()
        manifest = json.loads((directory / 'manifest.json').read_text())
        manifest['runId'] = 'nyatbot-20261114T160000Z-' + nonce
        backup.write_json(directory / 'manifest.json', manifest)
        target = Path(config['staging_root']) / manifest['runId']; directory.rename(target)
        receipt = {'version': 2, 'runId': manifest['runId'], 'uploadVerifiedAt': at.isoformat(),
                   'manifestSha256': backup.digest(target / 'manifest.json'), 'restored': False}
        backup.write_json(target / 'COMPLETE.json', receipt)
        return target

    def test_shanghai_0400_day_is_independent_of_host_timezone_year_and_dst(self):
        cases = [
            ('2026-12-31T19:59:59+00:00', '2026-12-31'),
            ('2026-12-31T20:00:00+00:00', '2027-01-01'),
            ('2027-01-01T03:59:59+08:00', '2026-12-31'),
            ('2027-01-01T04:00:00+08:00', '2027-01-01'),
            ('2026-03-08T01:59:59-06:00', '2026-03-08'),
            ('2026-03-08T03:00:00-05:00', '2026-03-08'),
            ('2026-11-01T01:30:00-05:00', '2026-11-01'),
            ('2026-11-01T01:30:00-06:00', '2026-11-01'),
            ('2028-02-29T19:59:59+00:00', '2028-02-29'),
            ('2028-02-29T20:00:00+00:00', '2028-03-01'),
        ]
        for value, expected in cases:
            with self.subTest(value=value): self.assertEqual(backup.backup_logical_day(dt.datetime.fromisoformat(value)), expected)
        with self.assertRaisesRegex(RuntimeError, 'timezone'): backup.backup_logical_day(dt.datetime(2026, 1, 1))

    def test_hourly_retry_skips_only_after_success_and_runs_again_after_cutoff(self):
        config = self.schedule_config(); at = dt.datetime.fromisoformat('2026-11-14T20:00:00+00:00')
        def capture(_config): return self.finalized_generation(config, at)
        with patch.object(backup, 'exclusive_lock', side_effect=lambda _path: contextlib.nullcontext()), patch.object(backup, 'capture', side_effect=capture) as execute:
            first = backup.capture_if_due(config, at)
            second = backup.capture_if_due(config, at + dt.timedelta(hours=23, minutes=59))
        self.assertFalse(first['skipped']); self.assertTrue(second['skipped']); execute.assert_called_once()
        at += dt.timedelta(days=1)
        with patch.object(backup, 'exclusive_lock', side_effect=lambda _path: contextlib.nullcontext()), patch.object(backup, 'capture', side_effect=lambda _: self.finalized_generation(config, at, 'abcdef123457')) as execute:
            third = backup.capture_if_due(config, at)
        self.assertFalse(third['skipped']); execute.assert_called_once()
        self.assertEqual(json.loads(Path(config['schedule_receipt']).read_text())['logicalDay'], '2026-11-16')

    def test_failure_or_interruption_never_advances_success_day(self):
        config = self.schedule_config(); at = dt.datetime.fromisoformat('2026-11-14T20:00:00+00:00')
        old = self.finalized_generation(config, at - dt.timedelta(days=1))
        old_receipt = json.loads((old / 'COMPLETE.json').read_text())
        backup.write_json(config['schedule_receipt'], {**old_receipt, 'logicalDay': '2026-11-14'})
        before = Path(config['schedule_receipt']).read_bytes()
        for error in (OSError('synthetic_upload_failed'), backup.BackupInterrupted('interrupted')):
            with self.subTest(error=type(error).__name__), patch.object(backup, 'exclusive_lock', side_effect=lambda _path: contextlib.nullcontext()), patch.object(backup, 'capture', side_effect=error) as execute:
                with self.assertRaises(type(error)): backup.capture_if_due(config, at)
                execute.assert_called_once()
            self.assertEqual(Path(config['schedule_receipt']).read_bytes(), before)

    def test_completed_upload_repairs_missing_schedule_receipt_without_another_snapshot(self):
        config = self.schedule_config(); at = dt.datetime.fromisoformat('2026-12-31T20:00:00+00:00')
        self.finalized_generation(config, at)
        with patch.object(backup, 'exclusive_lock', side_effect=lambda _path: contextlib.nullcontext()), patch.object(backup, 'capture') as execute:
            result = backup.capture_if_due(config, at + dt.timedelta(hours=1))
        execute.assert_not_called(); self.assertTrue(result['skipped'])
        self.assertEqual(json.loads(Path(config['schedule_receipt']).read_text())['logicalDay'], '2027-01-01')

    def test_pending_upload_legacy_marker_and_future_receipt_cannot_skip(self):
        config = self.schedule_config(); at = dt.datetime.fromisoformat('2026-11-14T20:00:00+00:00')
        generation = self.finalized_generation(config, at)
        marker = generation / 'COMPLETE.json'; valid = json.loads(marker.read_text())
        marker.rename(generation / 'COMPLETE.pending.json')
        for value in (None, {**valid, 'version': 1}, {**valid, 'uploadVerifiedAt': (at + dt.timedelta(hours=1)).isoformat()}, {**valid, 'logicalDay': '2027-01-01'}):
            if value: backup.write_json(marker, value)
            with self.subTest(value=value), patch.object(backup, 'exclusive_lock', side_effect=lambda _path: contextlib.nullcontext()), patch.object(backup, 'capture', side_effect=RuntimeError('required_new_capture')) as execute:
                with self.assertRaisesRegex(RuntimeError, 'required_new_capture'): backup.capture_if_due(config, at)
                execute.assert_called_once()
            self.assertFalse(Path(config['schedule_receipt']).exists())

    def test_even_an_already_successful_day_recovers_a_pending_writer_before_skipping(self):
        config = self.schedule_config(); at = dt.datetime.fromisoformat('2026-11-14T20:00:00+00:00')
        self.finalized_generation(config, at); self.journal_value(['nyatbot.service'])
        with patch.object(backup, 'exclusive_lock', side_effect=lambda _path: contextlib.nullcontext()), patch.object(backup, 'capture') as capture, patch.object(backup, 'command') as execute, patch.object(backup, 'unit_state', return_value={'ActiveState': 'active', 'MainPID': '789'}):
            self.assertTrue(backup.capture_if_due(config, at)['skipped'])
        execute.assert_called_once_with(['systemctl', 'start', 'nyatbot.service'], timeout=150)
        capture.assert_not_called(); self.assertFalse(self.journal.exists())

    def test_upload_interrupted_before_receipt_ack_never_creates_finalized_marker(self):
        generation = self.generation(); config = self.drive_config()
        def run(_config, args, **_kwargs):
            if 'cat' in args: return (generation / 'manifest.json').read_bytes()
            if 'copyto' in args:
                self.assertTrue((generation / 'COMPLETE.pending.json').exists())
                self.assertFalse((generation / 'COMPLETE.json').exists())
                raise backup.BackupInterrupted('before_remote_ack')
            return b''
        with patch.object(backup, 'validate_encrypted_drive'), patch.object(backup, 'rclone_command', side_effect=run):
            with self.assertRaises(backup.BackupInterrupted): backup.upload_generation(generation, config)
        self.assertFalse((generation / 'COMPLETE.json').exists())

    def retention_fixture(self):
        now = dt.datetime.fromisoformat('2026-11-15T12:00:00+00:00')
        generation = self.generation()
        manifest = json.loads((generation / 'manifest.json').read_text())
        manifest.update(producer=backup.PRODUCER, consistency='application_quiesced', createdUtc=now.isoformat(),
                        watermarks=backup.sqlite_watermarks(generation / 'sqlite.db', manifest['embedding']))
        backup.write_json(generation / 'manifest.json', manifest)
        receipt = {'version': 2, 'runId': self.run_id, 'manifestSha256': backup.digest(generation / 'manifest.json'),
                   'uploadVerifiedAt': now.isoformat(), 'restored': False}
        backup.write_json(generation / 'COMPLETE.json', receipt)
        objects = {self.run_id: {path.name: path.read_bytes() for path in generation.iterdir()}}
        config = {'drive': self.drive_config(), 'retention': {'enabled': True, **backup.RETENTION}}
        calls = []
        def execute(_drive, args, **_kwargs):
            action, target = args[:2]; calls.append((action, target))
            prefix = config['drive']['remote']
            if target == prefix:
                self.assertEqual(action, 'lsjson')
                return json.dumps([{'Name': key, 'Path': key, 'IsDir': True} for key in objects]).encode()
            self.assertTrue(target.startswith(prefix + '/'))
            relative = target[len(prefix) + 1:]; run, _, member = relative.partition('/')
            if action == 'lsjson':
                return json.dumps([{'Name': name, 'Path': name, 'Size': len(data), 'IsDir': False} for name, data in objects[run].items()]).encode()
            if action == 'cat': return objects[run][member]
            if action == 'deletefile': del objects[run][member]; return b''
            if action == 'rmdir':
                self.assertFalse(objects[run]); del objects[run]; return b''
            self.fail('unexpected remote action: ' + action)
        def add(at, suffix):
            run = 'nyatbot-' + at.strftime('%Y%m%dT%H%M%SZ') + '-' + suffix
            files = copy.deepcopy(objects[self.run_id]); body = copy.deepcopy(manifest)
            body.update(runId=run, createdUtc=at.isoformat())
            files['manifest.json'] = json.dumps(body, sort_keys=True).encode()
            done = {**receipt, 'runId': run, 'uploadVerifiedAt': at.isoformat(),
                    'manifestSha256': backup.hashlib.sha256(files['manifest.json']).hexdigest()}
            files['COMPLETE.json'] = json.dumps(done, sort_keys=True).encode()
            objects[run] = files
            return run
        return config, generation, now, objects, calls, execute, add

    def test_retention_union_keeps_calendar_day_week_month_and_latest_across_year(self):
        now = dt.datetime.fromisoformat('2027-01-01T12:00:00+00:00')
        generations = [{'runId': f'run-{i}', 'created': now - dt.timedelta(days=i)} for i in range(450)]
        keep = backup.retained_generations(generations, 'run-0', now)
        self.assertTrue({f'run-{i}' for i in range(14)} <= keep)
        self.assertLessEqual(len(keep), 34)
        self.assertNotIn('run-449', keep)
        today = dt.date.fromisoformat(backup.backup_logical_day(now))
        for age in range(8):
            week = today - dt.timedelta(days=today.weekday() + age * 7)
            latest = next(item for item in generations if week <= dt.date.fromisoformat(backup.backup_logical_day(item['created'])) < week + dt.timedelta(days=7))
            self.assertIn(latest['runId'], keep)
        self.assertIn('run-32', keep)  # Latest November generation across a year boundary.
        for age in range(12):
            expected_month = today.year * 12 + today.month - age
            latest = next(item for item in generations if (lambda day: day.year * 12 + day.month)(dt.date.fromisoformat(backup.backup_logical_day(item['created']))) == expected_month)
            self.assertIn(latest['runId'], keep)
        self.assertEqual(backup.retention_policy({})['enabled'], False)
        with self.assertRaises(RuntimeError): backup.retention_policy({'retention': {'enabled': True, 'daily': 1, 'weekly': 8, 'monthly': 12}})

    def test_retention_only_deletes_sealed_verified_exact_members_in_crypt_prefix(self):
        config, generation, now, objects, calls, execute, add = self.retention_fixture()
        old = add(now - dt.timedelta(days=500), 'abcdef123457')
        incomplete = add(now - dt.timedelta(days=501), 'abcdef123458'); objects[incomplete].pop('COMPLETE.json')
        unrelated = add(now - dt.timedelta(days=502), 'abcdef123459'); objects[unrelated]['private-extra.txt'] = b'preserve'
        corrupt = add(now - dt.timedelta(days=503), 'abcdef123460'); objects[corrupt]['manifest.json'] += b' '
        legacy = add(now - dt.timedelta(days=504), 'abcdef123461')
        body = json.loads(objects[legacy]['manifest.json']); body.pop('producer')
        objects[legacy]['manifest.json'] = json.dumps(body).encode()
        objects['unrelated-directory'] = {'keep.txt': b'preserve'}
        with patch.object(backup, 'validate_encrypted_drive'), patch.object(backup, 'rclone_command', side_effect=execute):
            result = backup.apply_retention(config, generation, now)
        self.assertEqual(result['deleted'], [old])
        self.assertEqual(result['ignored'], 5)
        self.assertEqual(set(objects), {self.run_id, incomplete, unrelated, corrupt, legacy, 'unrelated-directory'})
        destructive = [(action, path) for action, path in calls if action in ('deletefile', 'rmdir')]
        self.assertTrue(destructive)
        self.assertTrue(all(path.startswith(config['drive']['remote'] + '/' + old) for _, path in destructive))
        self.assertTrue(destructive[0][1].endswith('/COMPLETE.json'))
        self.assertFalse(any(action in ('purge', 'delete') for action, _ in calls))

    def test_retention_accepts_real_zero_byte_optional_wal_in_sealed_generation(self):
        config, generation, now, objects, calls, execute, _add = self.retention_fixture()
        (generation / 'sqlite.db-wal').write_bytes(b'')
        manifest = json.loads((generation / 'manifest.json').read_text())
        manifest['files'].append({'file': 'sqlite.db-wal', 'bytes': 0,
                                  'sha256': backup.digest(generation / 'sqlite.db-wal')})
        backup.write_json(generation / 'manifest.json', manifest)
        receipt = json.loads((generation / 'COMPLETE.json').read_text())
        receipt['manifestSha256'] = backup.digest(generation / 'manifest.json')
        backup.write_json(generation / 'COMPLETE.json', receipt)
        objects[self.run_id] = {item.name: item.read_bytes() for item in generation.iterdir()}
        with patch.object(backup, 'validate_encrypted_drive'), patch.object(backup, 'rclone_command', side_effect=execute):
            remote = backup.remote_generation(config['drive'], self.run_id, now)
            self.assertIsNotNone(remote)
            self.assertEqual(remote['members']['sqlite.db-wal'], 0)
            result = backup.apply_retention(config, generation, now)
        self.assertEqual(result['deleted'], [])
        self.assertFalse(any(action in ('deletefile', 'rmdir') for action, _ in calls))

    def test_remote_generation_rejects_negative_sizes_and_empty_required_components(self):
        config, _generation, now, objects, _calls, execute, _add = self.retention_fixture()
        original = copy.deepcopy(objects[self.run_id])
        cases = [('sqlite.db', -1), ('sqlite.db', 0), ('redis.rdb', 0),
                 ('qdrant-metadata.json', 0), ('qdrant-memory.snapshot', 0)]
        for name, size in cases:
            with self.subTest(name=name, size=size):
                files = copy.deepcopy(original); body = json.loads(files['manifest.json'])
                record = next(record for record in body['files'] if record['file'] == name)
                files[name] = b''; record['bytes'] = size; record['sha256'] = backup.hashlib.sha256(b'').hexdigest()
                files['manifest.json'] = json.dumps(body).encode()
                receipt = json.loads(files['COMPLETE.json']); receipt['manifestSha256'] = backup.hashlib.sha256(files['manifest.json']).hexdigest()
                files['COMPLETE.json'] = json.dumps(receipt).encode(); objects[self.run_id] = files
                with patch.object(backup, 'rclone_command', side_effect=execute):
                    self.assertIsNone(backup.remote_generation(config['drive'], self.run_id, now))

    def test_local_generation_rejects_empty_required_components_even_with_matching_hash(self):
        generation = self.generation()
        for name in ('sqlite.db', 'redis.rdb', 'qdrant-metadata.json'):
            with self.subTest(name=name):
                target = generation / name; original = target.read_bytes(); target.write_bytes(b'')
                self.rehash(generation)
                with self.assertRaisesRegex(RuntimeError, 'required_component_empty'): backup.verify_generation(generation)
                target.write_bytes(original); self.rehash(generation)

    def test_failed_current_upload_or_root_prefix_never_runs_cleanup(self):
        config, generation, now, objects, calls, execute, add = self.retention_fixture()
        add(now - dt.timedelta(days=500), 'abcdef123457')
        for failure in ('missing_marker', 'wrong_remote_receipt', 'root_prefix'):
            saved = (generation / 'COMPLETE.json').read_bytes()
            remote_saved = objects[self.run_id]['COMPLETE.json']; remote_name = config['drive']['remote']
            if failure == 'missing_marker': (generation / 'COMPLETE.json').unlink()
            elif failure == 'wrong_remote_receipt': objects[self.run_id]['COMPLETE.json'] += b' '
            else: config['drive']['remote'] = 'encrypted:/'
            with self.subTest(failure=failure), patch.object(backup, 'validate_encrypted_drive'), patch.object(backup, 'rclone_command', side_effect=execute):
                with self.assertRaises((RuntimeError, OSError)): backup.apply_retention(config, generation, now)
            self.assertFalse(any(action in ('deletefile', 'rmdir') for action, _ in calls))
            (generation / 'COMPLETE.json').write_bytes(saved); (generation / 'COMPLETE.json').chmod(0o600)
            objects[self.run_id]['COMPLETE.json'] = remote_saved; config['drive']['remote'] = remote_name

    def test_changed_generation_and_listing_failure_abort_before_deletion(self):
        config, generation, now, _objects, calls, execute, add = self.retention_fixture()
        old = add(now - dt.timedelta(days=500), 'abcdef123457')
        actual = backup.remote_generation; reads = 0
        def changing(drive, run, observed):
            nonlocal reads
            value = actual(drive, run, observed)
            if run == old:
                reads += 1
                if reads > 1: return None
            return value
        with patch.object(backup, 'validate_encrypted_drive'), patch.object(backup, 'rclone_command', side_effect=execute), patch.object(backup, 'remote_generation', side_effect=changing):
            with self.assertRaisesRegex(RuntimeError, 'generation_changed'): backup.apply_retention(config, generation, now)
        self.assertFalse(any(action in ('deletefile', 'rmdir') for action, _ in calls))
        def bad_listing(drive, args, **kwargs):
            if args[:2] == ['lsjson', drive['remote']]: raise RuntimeError('synthetic_listing_failed')
            return execute(drive, args, **kwargs)
        with patch.object(backup, 'validate_encrypted_drive'), patch.object(backup, 'rclone_command', side_effect=bad_listing):
            with self.assertRaisesRegex(RuntimeError, 'listing_failed'): backup.apply_retention(config, generation, now)
        self.assertFalse(any(action in ('deletefile', 'rmdir') for action, _ in calls))

    def test_partial_cleanup_stops_and_never_touches_retained_current(self):
        config, generation, now, objects, calls, execute, add = self.retention_fixture()
        old = add(now - dt.timedelta(days=500), 'abcdef123457')
        def failing(drive, args, **kwargs):
            if args[0] == 'deletefile' and not args[1].endswith('/COMPLETE.json'): raise RuntimeError('synthetic_delete_failed')
            return execute(drive, args, **kwargs)
        current = copy.deepcopy(objects[self.run_id])
        with patch.object(backup, 'validate_encrypted_drive'), patch.object(backup, 'rclone_command', side_effect=failing):
            with self.assertRaisesRegex(RuntimeError, 'delete_failed'): backup.apply_retention(config, generation, now)
        self.assertEqual(objects[self.run_id], current)
        self.assertNotIn('COMPLETE.json', objects[old])
        self.assertFalse(any(action == 'rmdir' for action, _ in calls))

    def test_authority_and_projection_watermarks_come_from_frozen_sqlite_without_bodies(self):
        generation = self.generation(); file = generation / 'sqlite.db'
        with contextlib.closing(sqlite3.connect(file)) as db:
            for name in ('0089_cognitive_events.sql', '0125_durable_ingress.sql', '0126_memory_projection.sql'):
                db.executescript((ROOT / 'migrations' / name).read_text(encoding='utf-8'))
            db.execute("INSERT INTO cognitive_events(id,type,scope_key,visibility,source,occurred_at,sequence,correlation_id,fact_json,created_at) VALUES('e1','sample','global','global','host',10,99,'c1','PRIVATE_CANARY',20)")
            db.execute("INSERT INTO ingress_inbox(event_id,lane,chat_id,platform,account_id,identity_json,payload_json,payload_hash,received_at_ms,updated_at_ms,state) VALUES('e1','telegram',42,'telegram','bot','{}','PRIVATE_CANARY','hash',100,101,'unknown')")
            db.execute("INSERT INTO memory_sources(source_id,legacy_id,platform,account_id,chat_id,message_id,body_json,text_body,visibility,version,event_order_ms,received_at,updated_at) VALUES('source','42_1','telegram','bot',42,1,'PRIVATE_CANARY','PRIVATE_CANARY','private',2,100,100,110)")
            model = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
            for version, state in ((1, 'pending'), (2, 'done')):
                db.execute('INSERT INTO memory_projection_jobs(source_id,version,model,collection,projection_id,state,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?)', ('source', version, model, 'memory', str(version), state, 100, 100))
            db.commit()
        embedding = {'model': model, 'collection': 'memory', 'dimensions': 384}
        watermarks = backup.sqlite_watermarks(file, embedding)
        self.assertEqual(watermarks['ingressInbox']['states'], {'unknown': 1})
        self.assertEqual(watermarks['memorySources']['rows'], 1)
        self.assertEqual(watermarks['memoryProjectionJobs']['maxDoneId'], 2)
        self.assertEqual(watermarks['memoryProjectionJobs']['terminalPrefixId'], 0)
        self.assertEqual(watermarks['currentProjectionRoute']['unfinishedCurrentVersionJobs'], 0)
        self.assertNotIn('PRIVATE_CANARY', json.dumps(watermarks))
        manifest = json.loads((generation / 'manifest.json').read_text()); manifest['watermarks'] = watermarks
        backup.write_json(generation / 'manifest.json', manifest); self.rehash(generation)
        backup.verify_generation(generation)
        manifest = json.loads((generation / 'manifest.json').read_text()); manifest['watermarks']['ingressInbox']['maxSequence'] = 999
        backup.write_json(generation / 'manifest.json', manifest)
        with self.assertRaisesRegex(RuntimeError, 'watermarks_mismatch'): backup.verify_generation(generation)

    def test_compression_uses_frozen_tar_after_writer_restart_not_changed_live_tree(self):
        staging = self.root / 'staging'; staging.mkdir(); live = self.root / 'live'; live.mkdir()
        document = live / 'note.txt'; document.write_text('snapshot-before-restart')
        source_db = self.root / 'source.db'
        with contextlib.closing(sqlite3.connect(source_db)) as db: db.execute('CREATE TABLE evidence(value TEXT)')
        config = {'release': 'a' * 40, 'embedding': {'model': 'synthetic/model', 'dimensions': 384, 'collection': 'memory'},
                  'staging_root': str(staging), 'sqlite_path': str(source_db), 'lock_file': str(self.root / 'lock'),
                  'min_free_bytes': 0, 'redis': {'binary': 'redis-cli', 'port': 1}, 'qdrant': {},
                  'archives': [{'name': 'files', 'path': str(live)}]}
        restarted = False
        @contextlib.contextmanager
        def stopped(_config, _run):
            nonlocal restarted
            try: yield []
            finally: restarted = True; document.write_text('changed-after-restart')
        def redis(args, **_kwargs): Path(args[-1]).write_bytes(b'fake-rdb')
        def qdrant(_config, destination):
            backup.write_json(destination / 'qdrant-metadata.json', {'aliases': {}, 'collections': {'memory': {'config': {'params': {'vectors': {'size': 384}}}}}})
            (destination / 'qdrant-memory.snapshot').write_bytes(b'fake-snapshot')
        real_compress = backup.compress_archive
        def compressed(path): self.assertTrue(restarted); return real_compress(path)
        with patch.object(backup, 'exclusive_lock', side_effect=lambda _: contextlib.nullcontext()), patch.object(backup, 'recover_writers'), patch.object(backup, 'stopped_writers', side_effect=stopped), patch.object(backup, 'command', side_effect=redis), patch.object(backup, 'snapshot_qdrant', side_effect=qdrant), patch.object(backup, 'compress_archive', side_effect=compressed):
            result = backup.capture(config, local_only=True)
        with tarfile.open(result / 'files.tar.gz') as archive:
            self.assertEqual(archive.extractfile('note.txt').read(), b'snapshot-before-restart')
        self.assertEqual(document.read_text(), 'changed-after-restart')
        self.assertFalse(list(result.glob('*.tar')))
        self.assertEqual(json.loads((result / 'manifest.json').read_text())['watermarks']['memorySources'], {'present': False})


if __name__ == '__main__':
    unittest.main()
