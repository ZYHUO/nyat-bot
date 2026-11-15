"""Execute release preparation offline with a fresh synthetic checkout."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
COMMIT = 'a' * 40
FAKE_TOOL = '''#!/usr/bin/python3
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parent.parent
tool, args = Path(sys.argv[0]).name, sys.argv[1:]
with (root / 'calls.jsonl').open('a') as output:
    output.write(json.dumps([tool, *args]) + '\\n')
if tool == 'node':
    print('22')
elif tool == 'git':
    if 'clone' in args:
        destination = Path(args[-1])
        destination.mkdir()
        (destination / '.git').mkdir()
    elif not any(command in args for command in ('cat-file', 'merge-base', 'checkout')):
        raise SystemExit('unexpected git invocation')
elif tool == 'npm':
    bundle = Path('dist/index.js')
    if args == ['run', 'build']:
        if (root / 'fail-build').exists():
            raise SystemExit(23)
        bundle.parent.mkdir()
        bundle.write_text('// freshly built bundle')
    elif args == ['test']:
        if not bundle.is_file():
            raise SystemExit('tests require a freshly built dist/index.js')
        assert bundle.read_text() == '// freshly built bundle'
    elif args not in (['ci', '--no-audit', '--no-fund'], ['run', 'typecheck'], ['run', 'lint']):
        raise SystemExit('unexpected npm invocation')
else:
    raise SystemExit('unexpected tool')
'''


class PrepareReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nyat-prepare-release-test-')
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.root / 'scratch').mkdir()
        self.script = self.root / 'prepare-release.sh'
        shutil.copyfile(ROOT / 'scripts/prepare-release.sh', self.script)
        for name in ('node', 'git', 'npm'):
            tool = self.bin / name
            tool.write_text(FAKE_TOOL)
            tool.chmod(0o755)
        self.destination = self.root / 'release'

    def tearDown(self):
        self.temp.cleanup()

    def prepare(self):
        identity = {}
        if os.geteuid() == 0:
            # Exercise the real non-root guard even when CI itself runs as root.
            for path in (self.root, *self.root.rglob('*')):
                os.chown(path, 65534, 65534)
            identity = {'user': 65534, 'group': 65534, 'extra_groups': []}
        return subprocess.run(
            ['/bin/bash', str(self.script), COMMIT, str(self.destination)],
            cwd=self.root,
            env={'PATH': f'{self.bin}:/usr/bin:/bin', 'TMPDIR': str(self.root / 'scratch')},
            text=True, capture_output=True, timeout=20, **identity,
        )

    def calls(self):
        return [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]

    def test_fresh_checkout_builds_bundle_before_running_tests(self):
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.destination / 'dist/index.js').read_text(), '// freshly built bundle')
        self.assertIn(['npm', 'test'], self.calls())
        self.assertEqual(json.loads((self.destination / 'build-provenance.json').read_text()), {
            'version': 1, 'release': COMMIT, 'branch': 'codex/onebot-qq',
        })

    def test_build_failure_stops_before_tests_and_provenance(self):
        (self.root / 'fail-build').touch()
        result = self.prepare()
        self.assertEqual(result.returncode, 23, result.stdout + result.stderr)
        self.assertNotIn(['npm', 'test'], self.calls())
        self.assertFalse((self.destination / 'build-provenance.json').exists())


if __name__ == '__main__':
    unittest.main()
