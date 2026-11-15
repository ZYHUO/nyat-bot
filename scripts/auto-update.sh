#!/usr/bin/env bash
# Legacy entrypoint fails closed until the isolated controller is installed.
# It never pulls main, overwrites the working tree, or builds as root.
set -euo pipefail
controller=/opt/nyatbot-release-control/release-controller.py
config=/etc/nyatbot-release-control/config.json
if [[ ! -f "$controller" || ! -f "$config" ]]; then
  echo 'A/B controller not installed; follow ops/releases/README.md. No update performed.' >&2
  exit 1
fi
exec /usr/bin/python3 "$controller" --config "$config" consume-request
