#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_PATH="${ROOT_DIR}/deploy/systemd/xxb-ts.service.template"
SERVICE_PATH="/etc/systemd/system/xxb-ts.service"
ENV_FILE="${ROOT_DIR}/.env"
ENTRYPOINT="${ROOT_DIR}/dist/index.js"

if [ ! -f "${TEMPLATE_PATH}" ]; then
  echo "Missing template: ${TEMPLATE_PATH}" >&2
  exit 1
fi

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

if [ ! -f "${ENTRYPOINT}" ]; then
  echo "Missing build output: ${ENTRYPOINT}" >&2
  echo "Run: npm run build" >&2
  exit 1
fi

NODE_BIN="$(node -p 'process.execPath')"
if [ ! -x "${NODE_BIN}" ]; then
  echo "Resolved node binary is not executable: ${NODE_BIN}" >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
cleanup() {
  rm -f "${TMP_FILE}"
}
trap cleanup EXIT

sed \
  -e "s|__WORKDIR__|${ROOT_DIR}|g" \
  -e "s|__ENV_FILE__|${ENV_FILE}|g" \
  -e "s|__NODE_BIN__|${NODE_BIN}|g" \
  -e "s|__ENTRYPOINT__|${ENTRYPOINT}|g" \
  "${TEMPLATE_PATH}" > "${TMP_FILE}"

install -m 0644 "${TMP_FILE}" "${SERVICE_PATH}"
systemctl daemon-reload
systemctl enable xxb-ts.service

echo "Installed ${SERVICE_PATH}"
echo "Use: systemctl restart xxb-ts"
