#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"${ROOT_DIR}/scripts/install-systemd.sh"

if command -v pm2 >/dev/null 2>&1; then
  pm2 delete xxb-ts >/dev/null 2>&1 || true
  pm2 save --force >/dev/null 2>&1 || true
fi

systemctl restart xxb-ts.service
systemctl status --no-pager xxb-ts.service
