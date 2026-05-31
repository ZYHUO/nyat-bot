#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NyatBot (xxb-ts) full deployment — one shot from a fresh clone to a running bot.
#
#   sudo ./scripts/deploy.sh
#
# Idempotent: re-run any time to update. It will:
#   1. preflight  — Node >= 22, Redis reachable
#   2. deps       — npm install (root + miniapp)
#   3. qdrant     — download the musl static binary + install/start qdrant.service
#   4. build      — tsup build + miniapp build
#   5. env        — ensure .env exists (copies .env.example on first run, then stops)
#   6. service    — install/enable/restart xxb-ts.service (migrations auto-apply on boot)
#   7. verify     — Qdrant healthz, xxb-ts active, "Bot started" in the log
#
# Flags: --skip-qdrant  --skip-build  --skip-deps  --no-restart
# Env:   QDRANT_VERSION (default 1.18.1)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

QDRANT_VERSION="${QDRANT_VERSION:-1.18.1}"
QDRANT_BIN="/usr/local/bin/qdrant"
QDRANT_STORAGE="${ROOT_DIR}/data/qdrant"
SKIP_QDRANT=0; SKIP_BUILD=0; SKIP_DEPS=0; NO_RESTART=0
for a in "$@"; do case "$a" in
  --skip-qdrant) SKIP_QDRANT=1 ;; --skip-build) SKIP_BUILD=1 ;;
  --skip-deps) SKIP_DEPS=1 ;; --no-restart) NO_RESTART=1 ;;
  *) echo "unknown flag: $a" >&2; exit 2 ;;
esac; done

c() { printf '\033[1;36m▶ %s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "run as root (sudo) — needs systemd + /usr/local/bin"

# node may live under fnm/nvm and not be on sudo's PATH — find it and prepend.
if ! command -v node >/dev/null 2>&1; then
  NODE_BIN="$(ls -d /root/.local/share/fnm/node-versions/*/installation/bin/node \
                   "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "${NODE_BIN:-}" ] && export PATH="$(dirname "$NODE_BIN"):$PATH"
fi

# ── 1. preflight ─────────────────────────────────────────────────────────────
c "Preflight"
command -v node >/dev/null || die "node not found (need >= 22); install Node 22+ or set PATH"
NODE_MAJ="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJ" -ge 22 ] || die "node $NODE_MAJ too old (need >= 22)"
ok "node $(node -v)"
if command -v redis-cli >/dev/null && redis-cli ping >/dev/null 2>&1; then
  ok "redis reachable"
else
  warn "redis not reachable — install/start it (apt install redis-server) and set REDIS_URL"
fi

# ── 2. deps ──────────────────────────────────────────────────────────────────
if [ "$SKIP_DEPS" = 0 ]; then
  c "Installing dependencies"
  npm install --no-audit --no-fund
  [ -d miniapp-web ] && npm --prefix miniapp-web install --no-audit --no-fund || true
  ok "deps installed"
fi

# ── 3. qdrant ────────────────────────────────────────────────────────────────
if [ "$SKIP_QDRANT" = 0 ]; then
  c "Qdrant vector DB"
  if [ ! -x "$QDRANT_BIN" ] || ! "$QDRANT_BIN" --version 2>/dev/null | grep -q "$QDRANT_VERSION"; then
    arch="$(uname -m)"; [ "$arch" = "x86_64" ] || die "unsupported arch $arch (edit script for aarch64)"
    # musl static build — no glibc version dependency
    url="https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}/qdrant-x86_64-unknown-linux-musl.tar.gz"
    c "  downloading qdrant ${QDRANT_VERSION} (musl)"
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    curl -fsSL "$url" -o "$tmp/q.tar.gz" || die "qdrant download failed: $url"
    tar xzf "$tmp/q.tar.gz" -C /usr/local/bin/ qdrant && chmod +x "$QDRANT_BIN"
    ok "installed $("$QDRANT_BIN" --version 2>&1 | head -1)"
  else
    ok "qdrant present ($("$QDRANT_BIN" --version 2>&1 | head -1))"
  fi
  mkdir -p "$QDRANT_STORAGE/storage" "$QDRANT_STORAGE/snapshots"
  sed -e "s|__QDRANT_BIN__|${QDRANT_BIN}|g" -e "s|__STORAGE__|${QDRANT_STORAGE}|g" \
    "${ROOT_DIR}/deploy/systemd/qdrant.service.template" > /etc/systemd/system/qdrant.service
  systemctl daemon-reload
  systemctl enable --now qdrant.service >/dev/null 2>&1 || systemctl restart qdrant.service
  for i in $(seq 1 20); do
    curl -fsS localhost:6333/healthz >/dev/null 2>&1 && break
    [ "$i" = 20 ] && die "qdrant not healthy after 20s"; sleep 1
  done
  ok "qdrant healthy on 127.0.0.1:6333"
fi

# ── 4. build ─────────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = 0 ]; then
  c "Building"
  npm run build
  [ -d miniapp-web ] && npm run build:miniapp || true
  ok "built dist/"
fi

# ── 5. env ───────────────────────────────────────────────────────────────────
c "Config"
if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env created from .env.example — fill in BOT_TOKEN, BOT_USERNAME, AI_PROVIDER_* keys"
  warn "then re-run: sudo ./scripts/deploy.sh"
  exit 0
fi
if grep -qE '^BOT_TOKEN=\s*$|^BOT_TOKEN=your' .env; then
  warn "BOT_TOKEN looks empty/placeholder in .env — the bot won't start until it's set"
fi
ok ".env present"
mkdir -p logs data

# ── 6. xxb-ts service ────────────────────────────────────────────────────────
c "Installing xxb-ts.service"
bash "${ROOT_DIR}/scripts/install-systemd.sh"
systemctl enable xxb-ts.service >/dev/null 2>&1 || true
if [ "$NO_RESTART" = 0 ]; then
  systemctl restart xxb-ts.service
  ok "xxb-ts restarted (SQLite migrations auto-apply on boot)"
else
  warn "skipped restart (--no-restart); run: systemctl restart xxb-ts"
fi

# ── 7. verify ────────────────────────────────────────────────────────────────
c "Verify"
sleep 8
[ "$(systemctl is-active qdrant)" = active ] && ok "qdrant: active" || warn "qdrant not active"
if [ "$(systemctl is-active xxb-ts)" = active ]; then
  ok "xxb-ts: active"
  if { tail -n 40 logs/app.log 2>/dev/null; journalctl -u xxb-ts -n 40 --no-pager 2>/dev/null; } | grep -q "Bot started"; then
    ok "bot started (polling)"
  else
    warn "no 'Bot started' yet — check logs/app.log or journalctl -u xxb-ts"
  fi
else
  warn "xxb-ts not active — journalctl -u xxb-ts -n 50"
fi

c "Done."
echo "  logs:   tail -f ${ROOT_DIR}/logs/app.log   (or journalctl -u xxb-ts -f)"
echo "  manage: systemctl {status,restart,stop} xxb-ts   ·   systemctl status qdrant"
