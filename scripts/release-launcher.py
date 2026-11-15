#!/usr/bin/env python3
"""Stable unprivileged systemd entrypoint; never imports the privileged controller."""
import json
import os
from pathlib import Path
import re
import sys


def main():
    if len(sys.argv) != 4 or os.geteuid() == 0:
        raise RuntimeError('launcher_requires_unprivileged_user_and_fixed_paths')
    release_root, runtime, node = (Path(value) for value in sys.argv[1:])
    for path in (release_root, runtime, node):
        if not path.is_absolute() or path.resolve(strict=True) != path:
            raise RuntimeError('launcher_paths_must_be_canonical')
        for part in (path, *path.parents):
            if part.stat().st_uid != 0 or part.stat().st_mode & 0o022:
                raise RuntimeError('launcher_paths_must_be_operator_owned')
    release = (release_root / 'current').resolve(strict=True)
    if release.parent != release_root or not re.fullmatch('[a-f0-9]{40}', release.name):
        raise RuntimeError('invalid_selected_release')
    manifest = json.loads((release / 'release-manifest.json').read_text())
    if manifest.get('release') != release.name or manifest.get('branch') != 'codex/onebot-qq':
        raise RuntimeError('invalid_release_manifest')
    if (runtime / 'migrations').resolve(strict=True) != release / 'migrations':
        raise RuntimeError('runtime_migrations_must_follow_selected_release')
    # Existing relative data/var/logs/skills/prompts remain in this stable CWD.
    # dotenv reads no local secret file: systemd injects the external environment.
    if (runtime / '.env').exists() or (runtime / '.env').is_symlink():
        raise RuntimeError('use_external_systemd_environment_file')
    os.chdir(runtime)
    os.environ['NYAT_RELEASE_ID'] = release.name
    os.environ['READINESS_ENABLED'] = 'true'
    os.environ['NODE_ENV'] = 'production'
    os.execv(str(node), [str(node), str(release / 'dist/index.js')])


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('release_launcher_preflight_failed', file=sys.stderr)
        raise SystemExit(1) from None
