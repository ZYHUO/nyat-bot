#!/usr/bin/env bash
# Build an explicitly pinned branch commit without runtime credentials or root.
# The output is untrusted until an operator copies, seals and approves it.
set -euo pipefail
if [[ $# != 2 || ! "$1" =~ ^[a-f0-9]{40}$ || $EUID == 0 ]]; then
  echo 'usage (dedicated non-root build user): prepare-release.sh <full-commit> <new-output-directory>' >&2
  exit 2
fi
commit=$1
destination=$2
[[ ! -e "$destination" && ! -L "$destination" ]] || { echo 'output already exists' >&2; exit 2; }
[[ $(node -p 'process.versions.node.split(".")[0]') == 22 ]] || { echo 'Node 22 required' >&2; exit 2; }
# A new HOME prevents npm from loading the authority account credentials.
build_home=$(mktemp -d)
env -i PATH="$PATH" HOME="$build_home" LANG=C.UTF-8 git -c core.hooksPath=/dev/null clone \
  --no-checkout --single-branch --branch codex/onebot-qq \
  https://github.com/ZYHUO/nyat-bot.git "$destination"
env -i PATH="$PATH" HOME="$build_home" LANG=C.UTF-8 git -C "$destination" cat-file -e "${commit}^{commit}"
env -i PATH="$PATH" HOME="$build_home" LANG=C.UTF-8 git -C "$destination" merge-base --is-ancestor "$commit" refs/remotes/origin/codex/onebot-qq
env -i PATH="$PATH" HOME="$build_home" LANG=C.UTF-8 git -C "$destination" -c core.hooksPath=/dev/null checkout --detach "$commit"
# Preserve the source metadata in private scratch space instead of deleting it.
mv -- "$destination/.git" "$build_home/source.git"
cd "$destination"
env -i PATH="$PATH" HOME="$build_home" LANG=C.UTF-8 npm ci --no-audit --no-fund
env -i PATH="$PATH" HOME="$build_home" LANG=C.UTF-8 npm run typecheck
env -i PATH="$PATH" HOME="$build_home" LANG=C.UTF-8 npm run lint
# Bundle-contract tests read dist/index.js, absent from a fresh checkout.
env -i PATH="$PATH" HOME="$build_home" LANG=C.UTF-8 npm run build
env -i PATH="$PATH" HOME="$build_home" LANG=C.UTF-8 npm test
# Tests can create synthetic relative data/var state. Preserve it in private
# scratch space, outside the fresh release payload; never copy live state here.
for generated in data var logs .probe coverage; do
  if [[ -e "$generated" || -L "$generated" ]]; then
    mv -- "$generated" "$build_home/test-$generated"
  fi
done
python3 - "$commit" <<'PY'
import json
import sys
from pathlib import Path
Path('build-provenance.json').write_text(json.dumps({
    'version': 1, 'release': sys.argv[1], 'branch': 'codex/onebot-qq'
}) + '\n')
PY
echo "Prepared pinned release $commit; operator review/seal/approval still required."
