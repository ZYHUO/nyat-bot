import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import tarfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('restore_drill', ROOT / 'scripts/restore-drill.py')
drill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drill)


class RestoreDrillTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='nyat-restore-test-')
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.source = self.root / 'remote-fixture'
        self.source.mkdir()
        self.work = self.root / 'quarantine-drill'
        self.work.mkdir()
        self.run_id = 'nyatbot-20261114T160000Z-abcdef123456'
        self.config = {'drive': {'remote': 'nyatcrypt:nyatbot'}, 'redis': {'port': 16379}, 'qdrant': {'url': 'http://127.0.0.1:16333'}}
        with contextlib.closing(sqlite3.connect(self.source / 'sqlite.db')) as db:
            db.execute('CREATE TABLE _migrations(name TEXT)')
            db.execute("INSERT INTO _migrations VALUES('0001_test.sql')")
            db.commit()
        (self.source / 'redis.rdb').write_bytes(b'not-a-real-redis-load')
        self.metadata = {'aliases': {'aliases': []}, 'collections': {
            'dense': {'points_count': 7, 'config': {'params': {'vectors': {'size': 384, 'distance': 'Cosine'}}}},
            'named': {'points_count': 2, 'config': {'params': {'vectors': {'text': {'size': 12, 'distance': 'Dot'}}, 'sparse_vectors': {'keywords': {}}}}},
        }}
        drill.backup.write_json(self.source / 'qdrant-metadata.json', self.metadata)
        for name in self.metadata['collections']:
            (self.source / f'qdrant-{name}.snapshot').write_bytes(b'not-a-real-qdrant-load')
        embedding = {'model': 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', 'dimensions': 384, 'collection': 'dense'}
        self.manifest = {'version': 1, 'runId': self.run_id, 'producer': drill.backup.PRODUCER,
            'createdUtc': '2026-11-14T16:00:00+00:00', 'consistency': 'application_quiesced', 'release': 'a' * 40,
            'embedding': embedding, 'migrations': ['0001_test.sql'],
            'watermarks': drill.backup.sqlite_watermarks(self.source / 'sqlite.db', embedding),
            'files': [{'file': path.name, 'bytes': path.stat().st_size, 'sha256': drill.backup.digest(path)} for path in self.source.iterdir()]}
        drill.backup.write_json(self.source / 'manifest.json', self.manifest)
        self.seal = {'version': 2, 'runId': self.run_id, 'uploadVerifiedAt': '2026-11-14T16:01:00+00:00',
            'manifestSha256': drill.backup.digest(self.source / 'manifest.json'), 'restored': False}
        drill.backup.write_json(self.source / 'COMPLETE.json', self.seal)

    def cloud(self, _config, args, _home, **_kwargs):
        if args == ['config', 'dump']:
            return json.dumps({'nyatcrypt': {'type': 'crypt', 'remote': 'drive:backups'}, 'drive': {'type': 'drive'}}).encode()
        if args[0] == 'cat':
            return (self.source / args[1].rsplit('/', 1)[1]).read_bytes()
        if args[0] == 'copy':
            self.assertEqual(args[1], 'nyatcrypt:nyatbot/' + self.run_id)
            target = Path(args[2])
            self.assertTrue(target.is_relative_to(self.work))
            self.assertEqual(list(target.iterdir()), [])
            for source in self.source.iterdir():
                shutil.copyfile(source, target / source.name)
            return b''
        raise AssertionError('unexpected cloud operation')

    def test_download_is_from_exact_crypt_generation_and_real_sqlite_is_verified(self):
        with patch.object(drill, 'rclone', side_effect=self.cloud) as remote:
            source, manifest = drill.download_generation(self.config, self.run_id, self.work)
        self.assertNotEqual(source, self.source)
        self.assertEqual(sum(call.args[1][0] == 'copy' for call in remote.call_args_list), 1)
        self.assertTrue(drill.sqlite_checks(source, manifest)['manifestWatermarksMatched'])
        self.assertEqual(drill.sqlite_checks(source, manifest)['migrationCount'], 1)

    def test_bad_id_or_seal_never_downloads_and_missing_cloud_never_uses_local_backup(self):
        with patch.object(drill, 'rclone') as remote:
            with self.assertRaisesRegex(drill.DrillError, 'invalid_run_id'):
                drill.download_generation(self.config, '../generation', self.work)
            remote.assert_not_called()
        self.seal['manifestSha256'] = '0' * 64
        drill.backup.write_json(self.source / 'COMPLETE.json', self.seal)
        with patch.object(drill, 'rclone', side_effect=self.cloud) as remote:
            with self.assertRaisesRegex(drill.DrillError, 'unsealed'):
                drill.download_generation(self.config, self.run_id, self.work)
            self.assertFalse(any(call.args[1][0] == 'copy' for call in remote.call_args_list))
        with patch.object(drill, 'rclone', side_effect=drill.DrillError('command_failed')):
            with self.assertRaisesRegex(drill.DrillError, 'command_failed'):
                drill.download_generation(self.config, self.run_id, self.work)
        self.assertFalse((self.work / 'cloud').exists())

    def test_download_tampering_and_extra_files_are_not_accepted(self):
        def bad(config, args, home, **kwargs):
            result = self.cloud(config, args, home, **kwargs)
            if args[0] == 'copy':
                (Path(args[2]) / 'redis.rdb').write_bytes(b'tampered')
            return result
        with patch.object(drill, 'rclone', side_effect=bad):
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                drill.download_generation(self.config, self.run_id, self.work)
        other = self.root / 'other-download'; other.mkdir()
        def extra(config, args, home, **kwargs):
            if args[0] == 'copy':
                target = Path(args[2])
                for source in self.source.iterdir(): shutil.copyfile(source, target / source.name)
                (target / 'unexpected-private-file').write_bytes(b'PRIVATE_CANARY')
                return b''
            return self.cloud(config, args, home, **kwargs)
        with patch.object(drill, 'rclone', side_effect=extra):
            with self.assertRaisesRegex(drill.DrillError, 'inventory_mismatch'):
                drill.download_generation(self.config, self.run_id, other)

    def test_archive_escape_and_link_are_refused_before_extraction(self):
        archive_path = self.work / 'data.tar.gz'
        for name, link in [('../outside', False), ('nested/link', True)]:
            with self.subTest(name=name):
                with tarfile.open(archive_path, 'w:gz') as archive:
                    member = tarfile.TarInfo(name)
                    if link: member.type = tarfile.SYMTYPE; member.linkname = '/production'
                    else: member.size = 4
                    archive.addfile(member, None if link else io.BytesIO(b'data'))
                manifest = {'files': [{'file': archive_path.name, 'bytes': archive_path.stat().st_size}]}
                with self.assertRaisesRegex(drill.DrillError, 'unsafe_restore_archive'):
                    drill.check_expansion_space(self.work, manifest, self.work)
        self.assertFalse((self.root / 'outside').exists())

    def test_mid_drill_failure_records_phase_stops_owned_children_and_retains_copies(self):
        config_path = self.work / 'backup.json'; config_path.write_text('{}'); config_path.chmod(0o600)
        quarantine = self.root / 'quarantine'; quarantine.mkdir()
        config = {**self.config, 'drive': {**self.config['drive'], 'binary': 'rclone',
            'config_file': 'rclone.conf', 'config_password_file': 'rclone.pass'}}
        args = SimpleNamespace(config=str(config_path), run_id=self.run_id, ready_timeout=30,
            redis_port=26379, qdrant_port=27333, qdrant_grpc_port=27334,
            node='node', redis_server='redis-server', redis_cli='redis-cli', qdrant='qdrant', nyatdb_probe='probe.mjs')
        def restore(_source, target, _config):
            target.mkdir(); (target / 'preserved').write_bytes(b'PRIVATE_CANARY')
        with contextlib.ExitStack() as patches:
            if os.name == 'nt':
                # This test exercises orchestration; Windows cannot represent a
                # POSIX 0600 mode. Real Linux permission checks remain enabled.
                original_stat = Path.stat
                def mode(path, *pos, **kw):
                    return SimpleNamespace(st_mode=0o100600) if path == config_path else original_stat(path, *pos, **kw)
                patches.enter_context(patch.object(Path, 'stat', mode))
            patches.enter_context(patch.object(drill, 'require_linux_root'))
            patches.enter_context(patch.object(drill, 'trusted_runtime'))
            patches.enter_context(patch.object(drill, 'validate_ports'))
            patches.enter_context(patch.object(drill.backup, 'load_config', return_value=config))
            patches.enter_context(patch.object(drill.backup, 'quarantine_root', return_value=quarantine))
            patches.enter_context(patch.object(drill, 'download_generation', return_value=(self.source, self.manifest)))
            patches.enter_context(patch.object(drill, 'check_expansion_space'))
            patches.enter_context(patch.object(drill.backup, 'restore_to_quarantine', side_effect=restore))
            patches.enter_context(patch.object(drill, 'sqlite_checks', return_value={'integrity': True}))
            patches.enter_context(patch.object(drill, 'redis_checks', return_value={'loadedRdb': True}))
            patches.enter_context(patch.object(drill, 'qdrant_checks', side_effect=ValueError('PRIVATE_CANARY')))
            nyatdb = patches.enter_context(patch.object(drill, 'nyatdb_checks'))
            closed = patches.enter_context(patch.object(drill.Children, 'close', return_value=True))
            receipt = drill.run_drill(args)
        self.assertEqual(receipt['status'], 'failed'); self.assertEqual(receipt['phase'], 'qdrant')
        self.assertEqual(receipt['error'], 'restore_stage_failed'); self.assertTrue(receipt['childrenStopped'])
        self.assertEqual(set(receipt['stages']), {'cloud', 'sqlite', 'redis'})
        self.assertNotIn('PRIVATE_CANARY', json.dumps(receipt)); closed.assert_called_once(); nyatdb.assert_not_called()
        self.assertEqual(len(list(quarantine.glob('restored-*/preserved'))), 1)
        stored = list(quarantine.glob('drill-*/RESTORE_DRILL.json'))
        self.assertEqual(len(stored), 1); self.assertEqual(json.loads(stored[0].read_text()), receipt)

    def test_sqlite_migration_or_watermark_mismatch_is_a_failure(self):
        for field, value in [('migrations', []), ('watermarks', {'version': 1})]:
            manifest = {**self.manifest, field: value}
            with self.subTest(field=field), self.assertRaises(drill.DrillError):
                drill.sqlite_checks(self.source, manifest)

    def test_all_qdrant_collections_vector_configs_counts_and_aliases_must_match(self):
        original = self.metadata['collections']
        counts = {'dense': 7, 'named': 2}
        self.assertEqual(drill.compare_collections(original, original, counts, counts)['denseDimensions'], [12, 384])
        changes = []
        changed = copy.deepcopy(original); changed['named']['config']['params']['vectors']['text']['size'] = 13; changes.append(changed)
        changed = copy.deepcopy(original); changed.pop('dense'); changes.append(changed)
        changed = copy.deepcopy(original); changed['named']['config']['params']['sparse_vectors'] = {}; changes.append(changed)
        for changed in changes:
            with self.assertRaises(drill.DrillError): drill.compare_collections(original, changed, counts, counts)
        with self.assertRaisesRegex(drill.DrillError, 'points'):
            drill.compare_collections(original, original, {'dense': 6, 'named': 2}, counts)
        with self.assertRaisesRegex(drill.DrillError, 'alias'):
            drill.alias_set({'aliases': [{'alias_name': '../escape', 'collection_name': 'dense'}]})

    def test_qdrant_compares_exact_counts_never_approximate_collection_statistics(self):
        original = copy.deepcopy(self.metadata['collections'])
        original['dense']['points_count'] = 999  # Legitimately approximate.
        exact = {'dense': 7, 'named': 2}
        result = drill.compare_collections(original, original, exact, exact)
        self.assertIs(result['pointsMatched'], True)
        self.assertEqual(result['points'], 9)
        legacy = drill.compare_collections(original, original, exact)
        self.assertIsNone(legacy['pointsMatched'])
        self.assertEqual(legacy['pointsBasis'], 'isolated_exact_count_only_no_frozen_exact_count')
        for invalid in (None, {}, {'dense': 7}, {'dense': True, 'named': 2}, {'dense': 7, 'named': -1}):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(drill.DrillError, 'frozen_exact_counts_invalid'):
                drill.compare_collections(original, original, exact, invalid)
        with self.assertRaisesRegex(drill.DrillError, 'exact_count_invalid'):
            drill.compare_collections(original, original, {'dense': True, 'named': 2})

    def test_qdrant_loader_uses_frozen_exact_counts_and_real_alias_response_shape(self):
        metadata = copy.deepcopy(self.metadata)
        metadata['collections']['dense']['points_count'] = 999
        metadata['exactCounts'] = {'dense': 7, 'named': 2}
        metadata['aliases'] = {'aliases': [{'alias_name': 'active', 'collection_name': 'dense'}]}
        drill.backup.write_json(self.source / 'qdrant-metadata.json', metadata)
        child = SimpleNamespace(poll=lambda: None)
        children = MagicMock(); children.start.return_value = child
        args = SimpleNamespace(qdrant='fixed-qdrant', qdrant_port=27333, qdrant_grpc_port=27334, ready_timeout=10)
        aliases = []
        def http(_port, _key, path, method='GET', data=None):
            if path == '/collections': return {'result': {'collections': [{'name': name} for name in metadata['collections']]}}
            if path == '/aliases': return {'result': {'aliases': aliases}}
            if path == '/collections/aliases':
                self.assertEqual(method, 'POST')
                self.assertEqual(data, {'actions': [{'create_alias': metadata['aliases']['aliases'][0]}]})
                aliases.extend(metadata['aliases']['aliases']); return {'result': True}
            name = path.split('/')[2]
            if path.endswith('/points/count'):
                self.assertEqual(method, 'POST'); self.assertEqual(data, {'exact': True})
                return {'result': {'count': metadata['exactCounts'][name]}}
            return {'result': metadata['collections'][name]}
        # Snapshot CLI is Unix-only; the body comparison and alias protocol are
        # still exercised on Windows without pretending to run a Qdrant daemon.
        with patch.object(drill, 'http_json', side_effect=http), patch.object(drill, 'owns_listener', return_value=True), \
                patch.object(drill, 'qdrant_snapshot_argument', side_effect=lambda path, name: str(path) + ':' + name):
            result = drill.qdrant_checks(args, self.source, self.work, children)
        self.assertIs(result['pointsMatched'], True); self.assertTrue(result['aliasesMatched'])
        self.assertEqual(result['aliases'], 1); self.assertEqual(result['points'], 9)
        self.assertEqual(children.start.call_args.args[0].count('--snapshot'), 2)

    def test_production_duplicate_and_occupied_ports_fail_before_any_daemon(self):
        for ports in ([16379, 27333, 27334], [26379, 16333, 27334], [26379, 26379, 27334]):
            with self.subTest(ports=ports), self.assertRaisesRegex(drill.DrillError, 'unsafe_restore_ports'):
                drill.validate_ports(self.config, ports)
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1', 0))
            with self.assertRaisesRegex(drill.DrillError, 'port_in_use'):
                drill.validate_ports(self.config, [occupied.getsockname()[1], 27333, 27334])

    def test_copy_path_cannot_escape_or_reuse_production(self):
        for name in ('../remote-fixture', str(self.source), 'a/../../x', 'a\\x', 'a:x'):
            with self.subTest(name=name), self.assertRaises(drill.DrillError):
                drill.relative_copy(self.work, name)

    def test_runtime_requires_canonical_absolute_code_and_root_owned_parent_chain(self):
        with self.assertRaisesRegex(drill.DrillError, 'untrusted'):
            drill.trusted_runtime('scripts/restore-drill.py')
        if os.name == 'posix':
            path = self.work / 'probe.mjs'; path.write_text('synthetic'); path.chmod(0o666)
            with self.assertRaisesRegex(drill.DrillError, 'untrusted'):
                drill.trusted_runtime(path)

    def test_child_environment_contains_no_bot_node_proxy_or_qdrant_overrides(self):
        with patch.dict(os.environ, {'BOT_TOKEN': 'PRIVATE_CANARY', 'NODE_OPTIONS': '--import=unsafe',
                                     'HTTP_PROXY': 'PRIVATE_CANARY', 'QDRANT__STORAGE__STORAGE_PATH': '/production'}):
            environment = drill.clean_environment(self.work)
        expected = {'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'}
        if os.name == 'nt': expected.update(('SystemRoot', 'TEMP', 'TMP'))
        self.assertEqual(set(environment), expected)
        self.assertNotIn('PRIVATE_CANARY', json.dumps(environment))

    def test_cleanup_only_signals_owned_children_and_waits_after_kill(self):
        class Child:
            def __init__(self, running, stuck=False): self.running, self.stuck, self.calls = running, stuck, []
            def poll(self): return None if self.running else 0
            def terminate(self): self.calls.append('terminate')
            def kill(self): self.calls.append('kill'); self.stuck = False
            def wait(self, timeout):
                self.calls.append('wait')
                if self.stuck: raise subprocess.TimeoutExpired('synthetic', timeout)
                self.running = False
        done, stuck = Child(False), Child(True, True)
        children = drill.Children(self.work); children.children = [done, stuck]
        with patch.object(os, 'kill', side_effect=AssertionError('must use only owned Popen handles')):
            self.assertTrue(children.close())
        self.assertEqual(done.calls, [])
        self.assertEqual(stuck.calls, ['terminate', 'wait', 'kill', 'wait'])
        self.assertTrue(self.source.exists())

    def test_wait_does_not_accept_health_from_a_foreign_listener_or_dead_child(self):
        child = SimpleNamespace(poll=lambda: 1)
        with patch.object(drill, 'owns_listener', return_value=False):
            with self.assertRaisesRegex(drill.DrillError, 'daemon_exited'):
                drill.wait_ready(child, 26379, lambda: self.fail('foreign health used'), 10)

    def test_real_nyatdb_copy_crc_and_scoped_queries_with_no_application_env(self):
        node = os.environ.get('NYATBOT_TEST_NODE') or shutil.which('node')
        self.assertIsNotNone(node, 'Node 22 is required by this repository')
        loader = ROOT / 'node_modules/tsx/dist/loader.mjs'
        engine = (ROOT / 'packages/nyatdb/src/engine.ts').as_uri()
        database = self.work / 'nyatdb'
        code = f'''import {{NyatDb}} from {json.dumps(engine)};
const db=NyatDb.open({{path:{json.dumps(str(database))}}});
db.chatAppend(-100,{{messageId:41,ts:1,uid:7,role:'user',text:'PRIVATE_SYNTHETIC_CANARY'}});
db.chatAppend(-200,{{messageId:41,ts:2,uid:8,role:'user',text:'OTHER_PRIVATE_CANARY'}});db.close();'''
        command = [node, '--import', loader.as_uri(), '--input-type=module', '-e', code]
        made = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=30)
        self.assertEqual(made.returncode, 0, made.stderr.decode(errors='replace'))
        # Build the same standalone entry used by tsup; runtime has no tsx,
        # node_modules, application configuration or bot-writable source import.
        bundled = self.work / 'restore-nyatdb-probe.mjs'
        build = 'import {build} from ' + json.dumps((ROOT / 'node_modules/esbuild/lib/main.js').as_uri()) + ';' + \
            'const r=await build({entryPoints:[' + json.dumps(str(ROOT / 'scripts/restore-nyatdb-probe.mts')) + '],outfile:' + \
            json.dumps(str(bundled)) + ',bundle:true,platform:"node",format:"esm",target:"node22",metafile:true});' + \
            'if(Object.values(r.metafile.outputs).some(o=>o.imports.some(i=>!i.path.startsWith("node:"))))throw Error("external_dependency");'
        built = subprocess.run([node, '--input-type=module', '-e', build], cwd=ROOT, capture_output=True, timeout=30)
        self.assertEqual(built.returncode, 0, built.stderr.decode(errors='replace'))
        probe = [node, str(bundled), str(database)]
        output = drill.execute(probe, self.work, 30)
        result = json.loads(output)
        self.assertEqual(result['sampledChats'], 2)
        self.assertEqual(result['sampledMessages'], 2)
        self.assertTrue(result['emptyScopeChecked'])
        self.assertNotIn(b'CANARY', output)
        with (database / 'heap.ndb').open('r+b') as heap:
            heap.seek(100); heap.write(b'corruption')
        with self.assertRaisesRegex(drill.DrillError, 'command_failed'):
            drill.execute(probe, self.work, 30)


if __name__ == '__main__':
    unittest.main()
