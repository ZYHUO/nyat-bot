import contextlib
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


export = load('qq_export', 'ops/qq-client-export.py')
collect = load('qq_collect', 'ops/qq-client-collect.py')
backup = load('qq_backup_controller', 'scripts/backup-controller.py')
CID = 'a' * 64


class QQBackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.addCleanup(self.tmp.cleanup)

    def bundle(self, name='profile/session', body=b'SYNTHETIC_SESSION', change=None):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w:gz') as archive:
            for directory in ('profile', 'config'):
                entry = tarfile.TarInfo(directory); entry.type = tarfile.DIRTYPE; archive.addfile(entry)
            entry = tarfile.TarInfo(name); entry.size = len(body); archive.addfile(entry, io.BytesIO(body))
        packed = raw.getvalue()
        instant = dt.datetime.now(dt.timezone.utc).isoformat()
        meta = {'version': 1, 'kind': 'qq-client', 'account': collect.ACCOUNT, 'containerId': CID,
                'imageId': collect.IMAGE, 'consistency': 'crash_consistent', 'sameInstantAsCentral': False,
                'snapshotStartedAt': instant, 'snapshotCompletedAt': instant,
                'bytes': len(packed), 'sha256': hashlib.sha256(packed).hexdigest()}
        if change: meta.update(change)
        return json.dumps(meta).encode() + b'\n' + packed, meta

    def snapshot(self, failure=None, expired=False, resume_failure=False):
        target = self.root / 'snapshot.tar'; target.write_bytes(b'tar')
        calls = []
        def command(args, **_kwargs):
            calls.append(args)
            if args[0] == '/usr/bin/timeout' and failure: raise failure
            if args[:2] == [export.DOCKER, 'unpause'] and resume_failure: raise RuntimeError('resume_failed')
            if args[:2] == ['/usr/bin/systemctl', 'show']:
                return b'LoadState=loaded\nActiveState=inactive\nJob=\nExecMainStartTimestampMonotonic=0\n'
            return b'active\n'
        states = iter(([True, True, False] if failure else [True, not expired, True, False]))
        def inspect(_cid):
            return {'State': {'Running': True, 'Paused': next(states)}}
        with patch.object(export, 'STAGING', self.root), patch.object(export, 'stop_watchdog', side_effect=lambda unit: calls.append(['/usr/bin/systemctl', 'stop', unit + '.timer'])), patch.object(export, 'persist_guard'), patch.object(export, 'clear_guard'), patch.object(export, 'tar_process', side_effect=command), patch.object(export, 'command', side_effect=command), patch.object(export, 'inspect', side_effect=inspect):
            try: result = export.capture_tar(CID, target)
            except BaseException as error: return calls, error
        return calls, result

    def test_timer_armed_before_pause_and_tar_is_local_bounded_then_resume(self):
        calls, result = self.snapshot()
        self.assertIsInstance(result, tuple)
        self.assertEqual(calls[0][0], '/usr/bin/systemd-run')
        self.assertIn('--on-active=45s', calls[0]); self.assertEqual(calls[0][-2], CID)
        self.assertIn('--timer-property=OnUnitActiveSec=5s', calls[0])
        self.assertEqual(calls[1][1], 'is-active')
        self.assertEqual(calls[2], [export.DOCKER, 'pause', CID])
        self.assertIn('30s', calls[3]); self.assertIn('--kill-after=5s', calls[3])
        self.assertEqual(calls[4], [export.DOCKER, 'unpause', CID])
        self.assertEqual(calls[5][1], 'stop')

    def test_tar_failure_unpauses_and_never_seals(self):
        calls, error = self.snapshot(RuntimeError('tar_failed'))
        self.assertIsInstance(error, RuntimeError)
        self.assertIn([export.DOCKER, 'unpause', CID], calls)

    def test_timeout_and_signal_unpause_with_independent_failsafe(self):
        for error in (subprocess.TimeoutExpired('tar', 30), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                calls, observed = self.snapshot(error)
                self.assertIsInstance(observed, type(error))
                self.assertIn([export.DOCKER, 'unpause', CID], calls)

    def test_watchdog_or_external_resume_invalidates_snapshot(self):
        _, error = self.snapshot(expired=True)
        self.assertRegex(str(error), 'window_invalid')

    def test_failed_unpause_leaves_independent_timer_armed(self):
        calls, error = self.snapshot(resume_failure=True)
        self.assertRegex(str(error), 'resume_failed')
        self.assertFalse(any(args[:2] == ['/usr/bin/systemctl', 'stop'] for args in calls))

    def test_unarmed_timer_never_pauses(self):
        with patch.object(export, 'persist_guard'), patch.object(export, 'command', side_effect=[b'', b'inactive']) as command:
            with self.assertRaisesRegex(RuntimeError, 'watchdog_not_armed'):
                export.capture_tar(CID, self.root / 'not-created')
        self.assertFalse(any(call.args[0][:2] == [export.DOCKER, 'pause'] for call in command.call_args_list))

    def test_simulated_sigkill_leaves_timer_that_targets_original_id_not_name(self):
        # SIGKILL cannot execute finally. The recovery command must already be
        # owned by systemd, not by Python/SSH. This is a command-contract test;
        # it does not pretend to kill the production exporter/container.
        with patch.object(export, 'persist_guard'), patch.object(export, 'command', side_effect=[b'', b'active']) as command:
            unit = export.arm_resume(CID)
        invocation = command.call_args_list[0].args[0]
        self.assertEqual(invocation[-3:], ['--watchdog', CID, unit])
        self.assertNotIn(export.CONTAINER, invocation)
        self.assertIn('--collect', invocation)
        self.assertIn('--timer-property=OnUnitActiveSec=5s', invocation)
        self.assertTrue(unit.startswith('nyatbot-qq-unpause-'))

    def test_wrong_image_and_existing_pause_are_refused(self):
        for fields in ({'Image': 'sha256:wrong'}, {'State': {'Running': True, 'Paused': True}}):
            data = {'Id': CID, 'Name': '/' + export.CONTAINER, 'Image': export.IMAGE,
                    'Config': {'User': '10001:10001'}, 'State': {'Running': True, 'Paused': False}, **fields}
            with patch.object(export, 'inspect', return_value=data), patch.object(export, 'command') as command:
                with self.assertRaises(RuntimeError): export.validate_container()
            command.assert_not_called()

    def test_forced_command_rejects_arbitrary_command_without_docker(self):
        with patch.object(export.os, 'geteuid', return_value=0, create=True), patch.object(export.sys, 'argv', ['export']), patch.dict(export.os.environ, {'SSH_ORIGINAL_COMMAND': 'cat /etc/passwd'}), patch.object(export, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'action_denied'): export.main()
        command.assert_not_called()

    def test_real_tar_hash_and_sealed_generation(self):
        incoming = self.root / '.incoming-a'; incoming.mkdir()
        data, metadata = self.bundle(); bundle = incoming / 'bundle'; bundle.write_bytes(data)
        with patch.object(collect, 'ROOT', self.root), patch.object(collect, 'fsync_dir'):
            receipt = collect.seal(bundle, incoming)
        self.assertEqual(receipt['sha256'], metadata['sha256'])
        self.assertFalse(receipt['sameInstantAsCentral'])
        self.assertEqual(json.loads((self.root / 'CURRENT.json').read_text()), receipt)
        self.assertTrue((self.root / receipt['generation'] / 'snapshot.tar.gz').is_file())

    def test_bad_hash_truncation_trailing_data_keep_existing_receipt(self):
        existing = self.root / 'CURRENT.json'; existing.write_text('OLD_RECEIPT')
        variants = [self.bundle(change={'sha256': '0' * 64})[0], self.bundle()[0][:-4], self.bundle()[0] + b'extra']
        for index, data in enumerate(variants):
            incoming = self.root / str(index); incoming.mkdir(); bundle = incoming / 'bundle'; bundle.write_bytes(data)
            with patch.object(collect, 'ROOT', self.root), patch.object(collect, 'fsync_dir'):
                with self.assertRaises(RuntimeError): collect.seal(bundle, incoming)
            self.assertEqual(existing.read_text(), 'OLD_RECEIPT')

    def test_archive_path_escape_and_symlink_are_refused_without_extract(self):
        for name in ('../escape', '/absolute', 'config/../../escape', 'unknown/file'):
            incoming = self.root / ('in-' + str(len(list(self.root.iterdir())))); incoming.mkdir()
            bundle = incoming / 'bundle'; bundle.write_bytes(self.bundle(name=name)[0])
            with self.assertRaisesRegex(RuntimeError, 'archive_unsafe'): collect.seal(bundle, incoming)
        path = self.root / 'symlink.tar.gz'
        with tarfile.open(path, 'w:gz') as archive:
            item = tarfile.TarInfo('profile/link'); item.type = tarfile.SYMTYPE; item.linkname = '/etc/passwd'; archive.addfile(item)
        with self.assertRaisesRegex(RuntimeError, 'archive_unsafe'): collect.validate_archive(path)

    def test_wrong_account_image_stale_or_atomic_claim_rejected(self):
        for change in ({'account': 'other'}, {'imageId': 'wrong'}, {'sameInstantAsCentral': True},
                       {'snapshotStartedAt': '2020-01-01T00:00:00+00:00'}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                collect.read_header(io.BytesIO(self.bundle(change=change)[0]))

    def test_hook_optional_and_no_secret_environment_forwarded(self):
        self.assertIsNone(backup.run_pre_capture({}))
        process = MagicMock(); process.wait.return_value = 1
        with patch.object(backup, 'trusted_hook', return_value=Path('/usr/local/libexec/fixed')), patch.object(backup.subprocess, 'Popen', return_value=process) as popen:
            with self.assertRaisesRegex(RuntimeError, 'pre_capture_failed'):
                backup.run_pre_capture({'pre_capture_script': '/usr/local/libexec/fixed'})
        self.assertEqual(popen.call_args.args[0], [str(Path('/usr/local/libexec/fixed'))])
        self.assertEqual(set(popen.call_args.kwargs['env']), {'PATH', 'LANG', 'HOME'})
        self.assertNotIn('shell', popen.call_args.kwargs)

    def test_hook_timeout_kills_process_group_before_return(self):
        process = MagicMock(pid=123); process.wait.side_effect = [subprocess.TimeoutExpired('fixed', 175), 0]; process.poll.return_value = None
        with patch.object(backup, 'trusted_hook', return_value=Path('/fixed')), patch.object(backup.subprocess, 'Popen', return_value=process), patch.object(backup.os, 'killpg', create=True) as kill:
            with self.assertRaises(subprocess.TimeoutExpired): backup.run_pre_capture({'pre_capture_script': '/fixed'})
        kill.assert_called_once_with(123, signal.SIGTERM)
        self.assertEqual(process.wait.call_args_list[0].kwargs['timeout'], 175)

    def test_hook_rejects_bot_owned_file_or_parent_before_execution(self):
        script = self.root / 'collect.py'; script.write_text('pass'); script.chmod(0o700)
        for untrusted in (script, script.parent):
            def owner(path):
                if path == untrusted: raise RuntimeError('private_control_file_must_be_root_owned')
            with patch.object(backup, 'require_root_owner', side_effect=owner), patch.object(backup.subprocess, 'Popen') as popen:
                with self.assertRaisesRegex(RuntimeError, 'root_owned'): backup.run_pre_capture({'pre_capture_script': str(script)})
            popen.assert_not_called()

    def test_root_service_uses_separate_root_application_not_bot_checkout(self):
        unit = (ROOT / 'ops/nyatbot-backup.service').read_text()
        self.assertEqual(unit.count('/opt/nyatbot-backup/app/scripts/backup-controller.py'), 2)
        self.assertNotIn('/opt/nyatbot/scripts/backup-controller.py', unit)

    def test_real_hook_receipt_must_be_current_verified_and_archived(self):
        incoming = self.root / '.incoming-a'; incoming.mkdir()
        bundle = incoming / 'bundle'; bundle.write_bytes(self.bundle()[0])
        with patch.object(collect, 'ROOT', self.root), patch.object(collect, 'fsync_dir'):
            receipt = collect.seal(bundle, incoming)
        (self.root / 'CURRENT.json').chmod(0o600)
        config = {'pre_capture_script': '/fixed', 'archives': [{'path': str(self.root)}]}
        process = MagicMock(); process.wait.return_value = 0
        def spawn(*_args, **kwargs):
            kwargs['stdout'].write(json.dumps(receipt).encode()); return process
        with patch.object(backup, 'trusted_hook', return_value=Path('/fixed')), patch.object(backup.subprocess, 'Popen', side_effect=spawn):
            observed = backup.run_pre_capture(config)
            self.assertEqual(observed['consistency'], 'crash_consistent')
            self.assertIs(observed['sameInstantAsCentral'], False)
            with self.assertRaisesRegex(RuntimeError, 'archive_not_in_backup'):
                backup.run_pre_capture({**config, 'archives': []})
            (self.root / receipt['generation'] / 'snapshot.tar.gz').write_bytes(b'tampered')
            with self.assertRaisesRegex(RuntimeError, 'snapshot_changed'): backup.run_pre_capture(config)

    def test_hook_failure_is_under_lock_before_any_writer_stop(self):
        calls = []
        @contextlib.contextmanager
        def lock(_path):
            calls.append('lock'); yield; calls.append('unlock')
        config = {'staging_root': str(self.root), 'lock_file': 'lock', 'min_free_bytes': 0}
        with patch.object(backup, 'validate_identity_metadata'), patch.object(backup, 'retention_policy'), patch.object(backup, 'exclusive_lock', side_effect=lock), patch.object(backup, 'recover_writers'), patch.object(backup, 'verify_live_release'), patch.object(backup, 'run_pre_capture', side_effect=lambda _: (calls.append('hook'), (_ for _ in ()).throw(RuntimeError('synthetic_failure')))[1]), patch.object(backup, 'stopped_writers') as stopped:
            with self.assertRaisesRegex(RuntimeError, 'synthetic_failure'): backup.capture(config, local_only=True)
        self.assertEqual(calls, ['lock', 'hook']); stopped.assert_not_called()
        self.assertFalse(any(self.root.rglob('COMPLETE.json')))

    def test_capture_labels_external_snapshot_separate_from_central_quiescence(self):
        observed = []
        snapshot = {'kind': 'qq-client', 'consistency': 'crash_consistent', 'sameInstantAsCentral': False}
        @contextlib.contextmanager
        def stopped(_config, _run):
            observed.append('stop'); yield []; observed.append('resume')
        def hook(_config): observed.append('qq_snapshot'); return snapshot
        config = {'staging_root': str(self.root), 'lock_file': 'lock', 'min_free_bytes': 0,
                  'sqlite_path': 'unused', 'redis': {'binary': 'redis-cli', 'port': 1}, 'qdrant': {},
                  'archives': [], 'release': 'a' * 40, 'embedding': {}}
        with patch.object(backup, 'validate_identity_metadata'), patch.object(backup, 'retention_policy'), patch.object(backup, 'exclusive_lock', side_effect=lambda _: contextlib.nullcontext()), patch.object(backup, 'recover_writers'), patch.object(backup, 'verify_live_release'), patch.object(backup, 'run_pre_capture', side_effect=hook), patch.object(backup, 'stopped_writers', side_effect=stopped), patch.object(backup, 'snapshot_sqlite', return_value=[]), patch.object(backup, 'snapshot_qdrant'), patch.object(backup, 'command'), patch.object(backup, 'sqlite_watermarks', return_value={}), patch.object(backup, 'verify_generation'):
            generation = backup.capture(config, local_only=True)
        manifest = json.loads((generation / 'manifest.json').read_text())
        self.assertEqual(observed, ['qq_snapshot', 'stop', 'resume'])
        self.assertEqual(manifest['consistencyScope'], 'central_bot_writers_only')
        self.assertEqual(manifest['externalSnapshots'], [snapshot])

    def test_live_release_revision_dist_and_extra_file_must_match(self):
        project = self.root / 'project'; project.mkdir(); dist = project / 'dist'; dist.mkdir()
        (dist / 'index.js').write_bytes(b'actual code')
        release = project / 'RELEASE.json'; release.write_text(json.dumps({'revision': 'a' * 40, 'dist': {'index.js': backup.digest(dist / 'index.js')}})); release.chmod(0o640)
        config = {'project_root': str(project), 'release_manifest_file': str(release), 'release': 'a' * 40}
        backup.verify_live_release(config)
        with self.assertRaisesRegex(RuntimeError, 'revision_mismatch'): backup.verify_live_release({**config, 'release': 'b' * 40})
        (dist / 'extra.js').write_bytes(b'extra')
        with self.assertRaisesRegex(RuntimeError, 'dist_mismatch'): backup.verify_live_release(config)
        (dist / 'extra.js').unlink(); (dist / 'index.js').write_bytes(b'tampered')
        with self.assertRaisesRegex(RuntimeError, 'dist_mismatch'): backup.verify_live_release(config)

    def test_root_pinned_release_hash_rejects_matching_app_manifest_and_code_tampering(self):
        project = self.root / 'project'; project.mkdir(); dist = project / 'dist'; dist.mkdir()
        (dist / 'index.js').write_bytes(b'original')
        manifest = project / 'RELEASE.json'
        def write_manifest():
            manifest.write_text(json.dumps({'revision': 'a' * 40, 'dist': {'index.js': backup.digest(dist / 'index.js')}})); manifest.chmod(0o640)
        write_manifest()
        config = {'project_root': str(project), 'release_manifest_file': str(manifest), 'release': 'a' * 40,
                  'release_manifest_sha256': backup.digest(manifest)}
        backup.verify_live_release(config)
        (dist / 'index.js').write_bytes(b'malicious-but-self-consistent'); write_manifest()
        with self.assertRaisesRegex(RuntimeError, 'expected_hash_mismatch'): backup.verify_live_release(config)

    def test_ambiguous_pause_timeout_does_not_retire_guard_or_cancel_timer(self):
        calls = []
        def command(args, **_kwargs):
            calls.append(args)
            if args[:2] == [export.DOCKER, 'pause']: raise subprocess.TimeoutExpired('docker', 15)
        with patch.object(export, 'arm_resume', return_value='owned'), patch.object(export, 'command', side_effect=command), patch.object(export, 'inspect', return_value={'State': {'Running': True, 'Paused': False}}), patch.object(export, 'clear_guard') as clear:
            with self.assertRaises(subprocess.TimeoutExpired): export.capture_tar(CID, self.root / 'unused')
        clear.assert_not_called()
        self.assertFalse(any(args[:2] == ['/usr/bin/systemctl', 'stop'] for args in calls))
        # A later completion of the pause is still covered by the repeating
        # timer, and a persisted guard prevents the next export from starting.
        (self.root / 'pause-guard.json').write_text('{}')
        with patch.object(export, 'STAGING', self.root), self.assertRaisesRegex(RuntimeError, 'operator_review'):
            export.ensure_no_guard()

    def test_early_timer_fire_then_late_pause_and_kill_has_another_trigger(self):
        with patch.object(export, 'persist_guard') as persist, patch.object(export, 'command', side_effect=[b'', b'active']) as command:
            unit = export.arm_resume(CID)
        persist.assert_called_once_with(CID, unit)
        args = command.call_args_list[0].args[0]
        initial = 45; repeat = 5; pause_completes_at = 46
        self.assertIn('--timer-property=OnUnitActiveSec=5s', args)
        self.assertGreater(initial + repeat, pause_completes_at)
        self.assertEqual(args[-2], CID)  # Repeat belongs to systemd after exporter death.

    def test_started_watchdog_service_never_clears_guard_for_next_capture(self):
        calls = []
        (self.root / 'pause-guard.fired').write_text('{}')
        def command(args, **_kwargs):
            calls.append(args)
            return b'LoadState=loaded\nActiveState=inactive\nJob=\nExecMainStartTimestampMonotonic=123\n'
        with patch.object(export, 'STAGING', self.root), patch.object(export, 'stop_watchdog'), patch.object(export, 'inspect', return_value={'State': {'Paused': False}}), patch.object(export, 'command', side_effect=command), patch.object(export, 'clear_guard') as clear:
            with self.assertRaisesRegex(RuntimeError, 'operator_review'): export.resume(CID, 'owned')
        clear.assert_not_called()
        self.assertIn(['/usr/bin/systemctl', 'start', 'owned.timer'], calls)

    @unittest.skipUnless(os.name == 'posix', 'POSIX process-group kill is verified on Linux; Windows has no killpg')
    def test_actual_timeout_reaps_term_ignoring_grandchild(self):
        pidfile = self.root / 'grandchild.pid'
        child = 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'
        parent = "import subprocess,sys,time,pathlib;p=subprocess.Popen([sys.executable,'-c',sys.argv[2]]);pathlib.Path(sys.argv[1]).write_text(str(p.pid));time.sleep(60)"
        with self.assertRaises(subprocess.TimeoutExpired):
            export.tar_process([sys.executable, '-c', parent, str(pidfile), child], timeout=0.5)
        pid = int(pidfile.read_text())
        for _ in range(20):
            status = Path('/proc') / str(pid) / 'stat'
            if not status.exists() or status.read_text().split()[2] == 'Z': break
            time.sleep(0.05)
        else: self.fail('grandchild survived owned process-group cleanup')


if __name__ == '__main__': unittest.main()
