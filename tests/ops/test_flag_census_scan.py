"""Offline scanner contract; optional GNU grep oracle needs no bot configuration."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[2] / 'scripts/lib/flag_census_scan.py'
spec = importlib.util.spec_from_file_location('flag_census_scan', MODULE)
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)


def grep_utf8_environment():
    """GNU grep uses libc's locale, unlike Python's Unicode regex engine.

    Old glibc lacks C.UTF-8 and silently falls back to byte-wise C matching.
    Select a locale only after `locale charmap` proves UTF-8 really activated.
    No Unicode boundary assertion is removed when a locale is unavailable.
    """
    locale = shutil.which('locale')
    if not locale:
        raise AssertionError('GNU grep oracle requires locale to verify its UTF-8 character semantics')
    # locale -a can contain legacy alias bytes unrelated to UTF-8 (old glibc).
    # Decode losslessly; locale charmap below, not this listing, proves the
    # candidate's actual character semantics. POSIX exec preserves surrogates.
    installed = subprocess.run([locale, '-a'], capture_output=True, check=True).stdout.decode(
        'utf-8', errors='surrogateescape').splitlines()
    candidates = dict.fromkeys(['C.UTF-8', 'C.utf8', 'en_US.UTF-8', 'en_US.utf8', *sorted(installed)])
    for candidate in candidates:
        environment = {**os.environ, 'LC_ALL': candidate}
        result = subprocess.run([locale, 'charmap'], env=environment, capture_output=True)
        if result.returncode == 0 and not result.stderr.strip() and result.stdout.strip().replace(b'-', b'').upper() == b'UTF8':
            return environment
    raise AssertionError('GNU grep oracle requires an installed UTF-8 locale; none passed locale charmap validation')


class CensusScannerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nyat-census-scan-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for tree in scan.ROOTS:
            (self.root / tree).mkdir()
        self.put('src/env.ts', 'env().FEATURE_FLAG; process.env.FEATURE_FLAG')
        self.put('src/env-sections/nested/schema.ts', 'env().FEATURE_FLAG')
        self.put('packages/nested/src/env.ts', 'env().FEATURE_FLAG')
        self.put('src/z getter.ts', '// env().FEATURE_FLAG\r\n')
        self.put('src/a-alias.mts', 'e.FEATURE_FLAG; ev.FEATURE_FLAG; cfg.FEATURE_FLAG')
        self.put('src/shim.js', 'envShim().FEATURE_FLAG')
        self.put('src/nul.ts', b'\x00prefix\x00env().FEATURE_FLAG\x00suffix')
        self.put('src/.ts', 'env().DOTFILE_FLAG')
        self.put('src/word-boundaries.ts', 'env().FEATURE_FLAG_EXTRA env().FEATURE_FLAG9 env().FEATURE_FLAG中 中FEATURE_FLAG')
        self.put('src/not-direct.ts', 'env() .FEATURE_FLAG; env().FEATURE_FLAG_')
        self.put('src/not-code.txt', 'env().FEATURE_FLAG')
        self.put('src/not-code.TS', 'env().FEATURE_FLAG')
        self.put('scripts/process.mts', 'process.env["FEATURE_FLAG_SUFFIX"]; process.env.FEATURE_FLAG')
        self.put('scripts/bracket-four.js', 'process.env[abcdFEATURE_FLAG_SUFFIX')
        self.put('scripts/bracket-five.js', 'process.env[abcdeFEATURE_FLAG_SUFFIX')
        self.put('scripts/bracket-newline.js', 'process.env[\nFEATURE_FLAG_SUFFIX')
        self.put('scripts/bracket-cr.js', 'process.env[abc\rFEATURE_FLAG_SUFFIX')
        self.put('scripts/only-script.ts', 'env().SCRIPT_ONLY')
        self.put('packages/only-package.js', 'env().PACKAGE_ONLY')
        self.put('tests/only-test.ts', 'env().TEST_ONLY; FEATURE_FLAG')
        self.put('unscanned/ignore.ts', 'env().FEATURE_FLAG')
        self.index = scan.ReaderIndex(self.root)

    def put(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content.encode('utf-8') if isinstance(content, str) else content)

    def test_all_six_categories_keep_their_original_scope_and_patterns(self):
        readers = self.index.readers_of('FEATURE_FLAG')
        self.assertEqual(set(readers), {'env_getter', 'destructured', 'env_shim', 'bare_word', 'process_env', 'tests'})
        self.assertEqual(readers['env_getter'], ['src/nul.ts', 'src/z getter.ts'])
        self.assertEqual(readers['destructured'], ['src/a-alias.mts'])
        self.assertEqual(readers['env_shim'], ['src/shim.js'])
        self.assertEqual(readers['process_env'], ['scripts/bracket-cr.js', 'scripts/bracket-four.js', 'scripts/process.mts'])
        self.assertEqual(readers['tests'], ['tests/only-test.ts'])
        self.assertIn('src/not-direct.ts', readers['bare_word'])
        self.assertNotIn('src/word-boundaries.ts', readers['bare_word'])
        self.assertEqual(self.index.readers_of('SCRIPT_ONLY')['env_getter'], [])
        self.assertEqual(self.index.readers_of('SCRIPT_ONLY')['bare_word'], ['scripts/only-script.ts'])
        self.assertEqual(self.index.readers_of('PACKAGE_ONLY')['bare_word'], ['packages/only-package.js'])
        self.assertEqual(self.index.readers_of('TEST_ONLY')['bare_word'], [])
        self.assertEqual(self.index.readers_of('TEST_ONLY')['tests'], ['tests/only-test.ts'])
        self.assertEqual(self.index.readers_of('DOTFILE_FLAG')['env_getter'], ['src/.ts'])

    def test_declarations_extensions_paths_and_missing_trees(self):
        for paths in self.index.readers_of('FEATURE_FLAG').values():
            self.assertEqual(paths, sorted(paths))
            self.assertFalse(any('\\' in path or scan.is_declaration(path) for path in paths))
            self.assertFalse(any(path.endswith(('.txt', '.TS')) or path.startswith('unscanned/') for path in paths))
        self.assertEqual(scan.ReaderIndex(self.root / 'missing').readers_of('FEATURE_FLAG')['bare_word'], [])

    def test_queries_do_not_reopen_files_or_spawn_commands_and_keep_snapshot(self):
        before = self.index.readers_of('FEATURE_FLAG')
        self.put('src/z getter.ts', 'removed')
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('query reread source')):
            with patch.object(subprocess, 'run', side_effect=AssertionError('query spawned a tool')):
                self.assertEqual(self.index.readers_of('FEATURE_FLAG'), before)
                self.assertEqual(self.index.readers_of('ABSENT_FLAG')['bare_word'], [])
        self.assertNotIn('src/z getter.ts', scan.ReaderIndex(self.root).readers_of('FEATURE_FLAG')['env_getter'])

    def test_reads_every_eligible_file_once_and_preserves_nul_cr_and_invalid_bytes(self):
        self.put('src/binary-text.ts', b'\xff\x00env().BINARY_FLAG\r\n')
        reads = []
        original = Path.read_bytes
        def counted(path):
            reads.append(path)
            return original(path)
        with patch.object(Path, 'read_bytes', counted):
            index = scan.ReaderIndex(self.root)
            for _ in range(3):
                self.assertEqual(index.readers_of('BINARY_FLAG')['env_getter'], ['src/binary-text.ts'])
        self.assertEqual(len(reads), len(set(reads)))
        self.assertEqual(len(reads), len(index.files))
        self.assertIn('\x00', dict(index.files)['src/nul.ts'])
        self.assertIn('\r', dict(index.files)['scripts/bracket-cr.js'])

    def test_gnu_grep_oracle_on_the_same_boundary_fixture(self):
        grep = shutil.which('grep')
        if not grep:
            self.skipTest('GNU grep is unavailable; cached scanner contracts above run on every platform')
        version = subprocess.run([grep, '--version'], capture_output=True, text=True, check=True)
        if 'GNU grep' not in version.stdout:
            self.skipTest('Installed grep is not GNU; the optional legacy oracle specifically requires GNU grep')
        # Existing source files are UTF-8. GNU's UTF-8 word boundary behavior,
        # rather than LC_ALL=C's byte-wise boundary, is the relevant oracle.
        environment = grep_utf8_environment()
        for name in ('FEATURE_FLAG', 'SCRIPT_ONLY', 'PACKAGE_ONLY', 'TEST_ONLY', 'ABSENT_FLAG', 'DOTFILE_FLAG'):
            actual = self.index.readers_of(name)
            for kind, (pattern, paths) in scan.reader_patterns(name).items():
                with self.subTest(name=name, reader=kind):
                    result = subprocess.run([grep, '-rlEZ', '--include=*.ts', '--include=*.mts', '--include=*.js',
                                             pattern, *paths], cwd=self.root, env=environment, capture_output=True)
                    self.assertIn(result.returncode, (0, 1), result.stderr.decode('utf-8', errors='replace'))
                    expected = sorted(path for path in result.stdout.decode('utf-8').split('\x00')
                                      if path and not scan.is_declaration(path))
                    self.assertEqual(actual[kind], expected)

    def test_oracle_rejects_silent_c_locale_fallback_before_selecting_installed_utf8(self):
        def run(args, **kwargs):
            if args[-1] == '-a':
                return subprocess.CompletedProcess(args, 0, b'C\nen_US.utf8\n', b'')
            candidate = kwargs['env']['LC_ALL']
            if candidate == 'en_US.utf8':
                return subprocess.CompletedProcess(args, 0, b'UTF-8\n', b'')
            return subprocess.CompletedProcess(args, 0, b'ANSI_X3.4-1968\n', b'Cannot set LC_ALL')
        with patch.object(shutil, 'which', return_value='/usr/bin/locale'):
            with patch.object(subprocess, 'run', side_effect=run):
                self.assertEqual(grep_utf8_environment()['LC_ALL'], 'en_US.utf8')
            with patch.object(subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, b'C\n', b'')):
                with self.assertRaisesRegex(AssertionError, 'none passed'):
                    grep_utf8_environment()

    def test_legacy_locale_alias_bytes_do_not_change_utf8_validation(self):
        observed = []
        def run(args, **kwargs):
            self.assertFalse(kwargs.get('text', False))
            if args[-1] == '-a':
                return subprocess.CompletedProcess(args, 0, b'C\nlegacy_\xe5\nen_US.utf8\n', b'')
            observed.append(kwargs['env']['LC_ALL'])
            if kwargs['env']['LC_ALL'] == 'en_US.utf8':
                return subprocess.CompletedProcess(args, 0, b'UTF-8\n', b'')
            return subprocess.CompletedProcess(args, 0, b'ANSI_X3.4-1968\n', b'bad alias \xe5')
        with patch.object(shutil, 'which', return_value='/usr/bin/locale'), patch.object(subprocess, 'run', side_effect=run):
            self.assertEqual(grep_utf8_environment()['LC_ALL'], 'en_US.utf8')
        self.assertNotIn('legacy_\udce5', observed)  # A proven UTF-8 locale was already found.


if __name__ == '__main__':
    unittest.main()
