#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
#  🐱 NyatBot (xxb-ts) — 一键部署 / one-shot installer
#
#    sudo ./scripts/deploy.sh
#
#  从零到机器人跑起来：环境检查 → 交互填配置(验证 token) → 依赖 → Qdrant →
#  （可选）NyatDB native（需 Rust；https://github.com/ZYHUO/nyatdb）→ 构建 → systemd →
#  红绿灯自检。幂等，可反复执行。NyatDB 默认关（.env.example NYATDB_*）。
#
#  常用：
#    sudo ./scripts/deploy.sh                 全新/更新部署（缺配置会交互引导）
#    sudo ./scripts/deploy.sh --update        快速更新：git pull + 重建(+nyatdb) + 重启
#    sudo ./scripts/deploy.sh --doctor        只体检，不改任何东西
#    sudo ./scripts/deploy.sh --uninstall     停服并卸载 systemd 单元（保留数据）
#    sudo ./scripts/deploy.sh --dry-run       打印将执行的命令，不真正执行
#  标志：--yes(非交互) --china(国内镜像/代理提示) --minimal(低内存最小部署)
#        --skip-qdrant --skip-build --skip-deps --no-restart --no-color
#  环境：QDRANT_VERSION(默认 1.18.1) · QDRANT_TARBALL(手动下载好的包) · HTTPS_PROXY
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT_DIR"
QDRANT_VERSION="${QDRANT_VERSION:-1.18.1}"
QDRANT_BIN="/usr/local/bin/qdrant"
QDRANT_STORAGE="${ROOT_DIR}/data/qdrant"
AI_PROVIDERS=(REPLY VISION JUDGE SUMMARIZE ALLOWLIST_REVIEW)

[ -f "$ROOT_DIR/package.json" ] || { echo "找不到项目根（别用 curl|bash，请先 git clone 再 cd 进去运行 ./scripts/deploy.sh）" >&2; exit 1; }

DRY=0; YES=0; CHINA=0; MINIMAL=0; DOCTOR=0; UNINSTALL=0; UPDATE=0; RECONFIG=0
SKIP_QDRANT=0; SKIP_BUILD=0; SKIP_DEPS=0; NO_RESTART=0; COLOR=1
for a in "$@"; do case "$a" in
  --dry-run) DRY=1 ;; --yes|-y) YES=1 ;; --china) CHINA=1 ;; --minimal) MINIMAL=1 ;;
  --doctor) DOCTOR=1 ;; --uninstall) UNINSTALL=1 ;; --update) UPDATE=1 ;; --reconfigure) RECONFIG=1 ;;
  --skip-qdrant) SKIP_QDRANT=1 ;; --skip-build) SKIP_BUILD=1 ;; --skip-deps) SKIP_DEPS=1 ;;
  --no-restart) NO_RESTART=1 ;; --no-color) COLOR=0 ;;
  -h|--help) sed -n '2,24p' "$0" | sed 's/^#\s\?//'; exit 0 ;;
  *) echo "未知参数: $a （--help 看用法）" >&2; exit 2 ;;
esac; done
[ -t 1 ] || COLOR=0

# ── UI helpers ───────────────────────────────────────────────────────────────
if [ "$COLOR" = 1 ]; then C_B='\033[1;36m'; C_G='\033[1;32m'; C_Y='\033[1;33m'; C_R='\033[1;31m'; C_D='\033[2m'; C_0='\033[0m'
else C_B=''; C_G=''; C_Y=''; C_R=''; C_D=''; C_0=''; fi
STEP=0; TOTAL=7
step() { STEP=$((STEP + 1)); printf "\n${C_B}[%d/%d] %s${C_0}  ${C_D}%s${C_0}\n" "$STEP" "$TOTAL" "$1" "${2:-}"; }
ok()   { printf "  ${C_G}✓${C_0} %s\n" "$*"; }
warn() { printf "  ${C_Y}!${C_0} %s\n" "$*"; }
info() { printf "  ${C_D}%s${C_0}\n" "$*"; }
die_fix() { printf "\n  ${C_R}✗ %s${C_0}\n  ${C_D}修复:${C_0} %s\n" "$1" "$2" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf "  ${C_D}+ %s${C_0}\n" "$*"; else "$@"; fi; }
ask()  { local p="$1" d="${2:-}" v; if [ "$YES" = 1 ]; then printf '%s' "$d"; return; fi
  read -r -p "  $p${d:+ [$d]}: " v </dev/tty || true; printf '%s' "${v:-$d}"; }
ask_secret() { local p="$1" v; if [ "$YES" = 1 ]; then return; fi
  read -r -s -p "  $p: " v </dev/tty || true; echo >/dev/tty; printf '%s' "$v"; }
confirm() { [ "$YES" = 1 ] && return 0; local v; read -r -p "  $1 [y/N] " v </dev/tty || true; [ "${v,,}" = y ]; }

banner() {
  printf "${C_B}"
  cat <<'EOF'
  ╔══════════════════════════════════════════╗
  ║   🐱  NyatBot 部署向导                    ║
  ║   Telegram AI 群聊喵娘机器人              ║
  ╚══════════════════════════════════════════╝
EOF
  printf "${C_0}"
}

# write/replace a KEY=VALUE in .env idempotently, value-safe (no interpolation), perms 600
set_env() {
  local k="$1" v="$2" tmp; tmp="$(mktemp)"
  grep -v "^${k}=" .env >"$tmp" 2>/dev/null || true   # drop ALL existing lines for this key
  printf '%s=%s\n' "$k" "$v" >>"$tmp"                  # append value verbatim
  install -m 600 "$tmp" .env; rm -f "$tmp"
}

# ── node resolution (fnm/nvm, incl. the sudo-invoking user's home) ───────────
if ! command -v node >/dev/null 2>&1; then
  SUH="$(getent passwd "${SUDO_USER:-}" 2>/dev/null | cut -d: -f6 || true)"
  N="$(ls -d /root/.local/share/fnm/node-versions/*/installation/bin/node \
        "$HOME"/.nvm/versions/node/*/bin/node \
        ${SUH:+"$SUH"/.nvm/versions/node/*/bin/node} \
        ${SUH:+"$SUH"/.local/share/fnm/node-versions/*/installation/bin/node} 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "${N:-}" ] && export PATH="$(dirname "$N"):$PATH"
fi
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# ── package manager + arch ───────────────────────────────────────────────────
detect_pm() { for p in apt-get dnf yum zypper pacman; do command -v "$p" >/dev/null 2>&1 && { echo "$p"; return; }; done; return 1; }
qdrant_arch() { case "$(uname -m)" in
  x86_64|amd64) echo x86_64-unknown-linux-musl ;;
  aarch64|arm64) echo aarch64-unknown-linux-musl ;;
  *) die_fix "CPU 架构 $(uname -m) 不支持" "换 x86_64 / ARM64 机器，或用 Docker 部署" ;;
esac; }

# ─────────────────────────────────────────────────────────────────────────────
#  --doctor : read-only health check
# ─────────────────────────────────────────────────────────────────────────────
if [ "$DOCTOR" = 1 ]; then
  banner; echo "  体检（只读，不改动）"
  printf "  node:   %s\n" "$(command -v node >/dev/null && node -v || echo '未安装')"
  printf "  redis:  %s\n" "$(redis-cli ping 2>/dev/null || echo '不可达')"
  printf "  qdrant: %s (%s)\n" "$(systemctl is-active qdrant 2>/dev/null || echo n/a)" "$(curl -fsS localhost:6333/healthz 2>/dev/null || echo no-health)"
  printf "  xxb-ts: %s\n" "$(systemctl is-active xxb-ts 2>/dev/null || echo n/a)"
  printf "  cargo:  %s\n" "$(command -v cargo >/dev/null && rustc --version 2>/dev/null || echo '未安装（NyatDB 可用 TS 引擎）')"
  if ls native/nyatdb/*.node >/dev/null 2>&1; then printf "  nyatdb: native addon 已编译 (%s)\n" "$(ls native/nyatdb/*.node 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
  else printf "  nyatdb: 无 native .node（默认关；引擎 https://github.com/ZYHUO/nyatdb ）\n"; fi
  printf "  内存:   %s | 磁盘(本目录): %s\n" "$(free -h | awk 'NR==2{print $7" 可用"}')" "$(df -h "$ROOT_DIR" | awk 'NR==2{print $4" 可用"}')"
  echo "  最近日志:"; { tail -n 15 logs/app.log 2>/dev/null || journalctl -u xxb-ts -n 15 --no-pager 2>/dev/null; } | sed 's/^/    /'
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
#  --uninstall : stop + remove units (keep data)
# ─────────────────────────────────────────────────────────────────────────────
if [ "$UNINSTALL" = 1 ]; then
  banner; confirm "停止并卸载 xxb-ts + qdrant 服务单元？（数据保留在 data/）" || exit 0
  run systemctl disable --now xxb-ts.service 2>/dev/null || true
  run systemctl disable --now qdrant.service 2>/dev/null || true
  run rm -f /etc/systemd/system/xxb-ts.service /etc/systemd/system/qdrant.service
  run systemctl daemon-reload
  ok "已停服并移除单元。数据仍在 ${ROOT_DIR}/data（彻底删除请自行 rm -rf）"
  exit 0
fi

[ "$(id -u)" = 0 ] || die_fix "需要 root 权限（systemd + /usr/local/bin）" "sudo ./scripts/deploy.sh"

# ─────────────────────────────────────────────────────────────────────────────
#  --update : fast path (no wizard, no qdrant reinstall)
# ─────────────────────────────────────────────────────────────────────────────
if [ "$UPDATE" = 1 ]; then
  banner; step "更新代码并重启" "git pull · 重建 · 重启"
  if [ -d .git ]; then run git pull --ff-only || die_fix "git pull 失败（有本地改动？）" "git stash 或 git reset --hard origin/main 后重跑 --update"
  else warn "非 git 仓库，跳过 pull"; fi
  if [ -f package-lock.json ]; then run npm ci --no-audit --no-fund; else run npm install --no-audit --no-fund; fi
  if [ -f native/nyatdb/package.json ]; then
    run bash -c 'cd native/nyatdb && NODE_ENV=development npm install --no-audit --no-fund' || true
    # shellcheck disable=SC1090
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    export PATH="${HOME}/.cargo/bin:${PATH}"
    if command -v cargo >/dev/null 2>&1; then
      run npm run build:nyatdb || warn "NyatDB native 编译失败（将用 TS 引擎）"
    else
      info "无 cargo，跳过 NyatDB native（https://github.com/ZYHUO/nyatdb ）"
    fi
  fi
  run npm run build
  if [ "$NO_RESTART" = 1 ] || [ "$DRY" = 1 ]; then ok "已更新（未重启，按需 systemctl restart xxb-ts）"; exit 0; fi
  run systemctl restart xxb-ts.service; sleep 5
  systemctl is-active --quiet xxb-ts && ok "已更新并重启" || die_fix "重启后未运行" "sudo journalctl -u xxb-ts -n 80 --no-pager"
  exit 0
fi

banner

# ── 1. 环境预检 ──────────────────────────────────────────────────────────────
step "环境预检" "约 10 秒"
command -v systemctl >/dev/null || die_fix "没有 systemd（容器/OpenVZ？）" "请用 Docker 部署：docker compose up -d"
qdrant_arch >/dev/null  # 架构不支持会在此 die
ok "架构 $(uname -m)"

# node 22
if [ "$(node_major)" -ge 22 ]; then ok "node $(node -v)"; else
  warn "需要 Node.js ≥ 22（当前: $(command -v node >/dev/null && node -v || echo 无)）"
  if pm="$(detect_pm)" && confirm "自动安装 Node 22？"; then
    case "$pm" in
      apt-get) run apt-get update -y; run apt-get install -y ca-certificates curl gnupg
               run bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'; run apt-get install -y nodejs ;;
      dnf|yum) run bash -c 'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -'; run "$pm" install -y nodejs ;;
      *) die_fix "此系统无法自动装 Node 22" "手动安装 Node 22+ 后重跑" ;;
    esac
    [ "$(node_major)" -ge 22 ] || die_fix "Node 22 安装后仍不可用" "检查 node -v"
    ok "node $(node -v)"
  else die_fix "缺少 Node.js ≥ 22" "安装 Node 22+（推荐 fnm/nvm）后重跑"; fi
fi

# 编译工具（better-sqlite3 + 可选 NyatDB Rust addon）
if command -v g++ >/dev/null && command -v python3 >/dev/null && command -v make >/dev/null; then ok "编译工具齐全"
else
  warn "缺少编译工具（装 sqlite 原生模块需要 g++/python3/make）"
  if pm="$(detect_pm)" && confirm "自动安装编译工具？"; then
    case "$pm" in apt-get) run apt-get update -y; run apt-get install -y build-essential python3 ;;
      dnf|yum) run "$pm" groupinstall -y "Development Tools"; run "$pm" install -y python3 ;;
      *) warn "请手动安装 build 工具" ;; esac
  else warn "稍后 npm install 可能编译失败：sudo apt install -y build-essential python3"; fi
fi

# Rust（可选：NyatDB native；缺省则走 TS 引擎，功能可用但点查更慢）
# 引擎独立仓库：https://github.com/ZYHUO/nyatdb
if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
  ok "Rust $(rustc --version 2>/dev/null | awk '{print $2}')（可编 NyatDB native）"
elif [ "$MINIMAL" = 0 ] && confirm "安装 Rust（用于可选的 NyatDB native 加速；不装则用 TS 引擎）？"; then
  run bash -c 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y'
  # shellcheck disable=SC1090
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  export PATH="${HOME}/.cargo/bin:${PATH}"
  command -v cargo >/dev/null && ok "Rust 已安装" || warn "Rust 安装后仍不可用，将跳过 NyatDB native"
else
  info "未装 Rust：NyatDB 将用 TS 引擎（默认关；见 .env.example NYATDB_*）"
fi

# 内存 / swap （探测失败时退化为 0，不让算术在 set -e 下崩）
MEM_KB="$(grep -m1 MemAvailable /proc/meminfo 2>/dev/null | awk '{print $2}')"; [[ "$MEM_KB" =~ ^[0-9]+$ ]] || MEM_KB=0
MEM_MB=$(( MEM_KB / 1024 ))
if [ "$MEM_MB" != 0 ] && [ "$MEM_MB" -lt 1800 ]; then
  warn "可用内存约 ${MEM_MB}MB —— 编译/运行可能被系统 Killed"
  if ! swapon --show 2>/dev/null | grep -q .; then
    warn "无 swap。建议加 2G：sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
  fi
  if [ "$MINIMAL" = 0 ] && confirm "内存偏小，切到 --minimal 最小部署（跳过 miniapp + Qdrant，构建限内存）？"; then MINIMAL=1; fi
elif [ "$MEM_MB" != 0 ]; then ok "内存 ${MEM_MB}MB 可用"; fi

# 磁盘
DISK_MB="$(df -m "$ROOT_DIR" 2>/dev/null | awk 'NR==2{print $4}')"; [[ "$DISK_MB" =~ ^[0-9]+$ ]] || DISK_MB=999999
if [ "$DISK_MB" -lt 800 ]; then warn "磁盘可用 ${DISK_MB}MB 偏少（建议 ≥1G）"; else ok "磁盘充足"; fi

# redis（队列必需）
if redis-cli ping >/dev/null 2>&1; then ok "redis 已就绪"
elif systemctl list-unit-files 2>/dev/null | grep -qE '^redis(-server)?\.service'; then
  run systemctl enable --now redis-server.service 2>/dev/null || run systemctl enable --now redis.service || true
  sleep 1; redis-cli ping >/dev/null 2>&1 && ok "redis 已启动" || die_fix "redis 未能启动" "sudo systemctl status redis-server"
elif pm="$(detect_pm)" && confirm "未检测到 Redis（机器人队列必需），自动安装？"; then
  case "$pm" in apt-get) run apt-get update -y; run apt-get install -y redis-server; run systemctl enable --now redis-server ;;
    dnf|yum) run "$pm" install -y redis; run systemctl enable --now redis ;;
    *) die_fix "请手动安装 Redis" "装好后重跑" ;; esac
  redis-cli ping >/dev/null 2>&1 && ok "redis 已就绪" || die_fix "redis 安装后不可达" "sudo systemctl status redis-server"
else die_fix "Redis 不可达（机器人队列必需）" "sudo apt install -y redis-server && sudo systemctl enable --now redis-server"; fi

if [ "$CHINA" = 1 ]; then
  run npm config set registry https://registry.npmmirror.com
  info "已切 npm 淘宝镜像（还原：npm config delete registry）。GitHub/Telegram/AI 端点如被墙，请 export HTTPS_PROXY=…"
fi

# ── 2. 配置（前置！缺就交互引导，未配置则非零退出）────────────────────────────
step "配置 .env" "填机器人 token 和 AI 接口"
[ -s .env ] || install -m 600 .env.example .env
# 未配置 = token 缺失/空/占位，或 AI key 仍是 ***/占位
ENV_OK=1
grep -q '^BOT_TOKEN=' .env || ENV_OK=0
grep -qE '^BOT_TOKEN=([[:space:]]*$|your|123456:|\*)' .env && ENV_OK=0
grep -qE '^AI_PROVIDER_REPLY_KEY=([[:space:]]*$|\*\*\*|your)' .env && ENV_OK=0
[ "$RECONFIG" = 1 ] && ENV_OK=0
if [ "$ENV_OK" = 1 ]; then
  chmod 600 .env 2>/dev/null || true; ok ".env 已配置"
elif [ "$DRY" = 1 ]; then
  ok "(dry-run) 这里会交互引导填 BOT_TOKEN + AI 接口"
elif [ "$YES" = 1 ] || ! { : >/dev/tty; } 2>/dev/null; then
  die_fix "尚未配置 .env（BOT_TOKEN/AI 为空或占位）" "编辑 $(pwd)/.env 填好，或在交互终端运行（ssh 记得加 -t）"
else
  cp -p .env .env.bak 2>/dev/null || true
  trap 'mv -f .env.bak .env 2>/dev/null || true; printf "\n  已取消，.env 未改动\n" >&2; exit 130' INT
  info "找 @BotFather → /newbot 拿 token（形如 123456789:AAH...）"
  for _try in 1 2 3; do
    TOK="$(ask_secret 'Telegram BOT_TOKEN')"
    [ -z "$TOK" ] && { warn "不能为空"; continue; }
    UNAME="$(curl -fsS --connect-timeout 8 --max-time 20 ${HTTPS_PROXY:+-x "$HTTPS_PROXY"} "https://api.telegram.org/bot${TOK}/getMe" 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.ok&&j.result&&j.result.username)||"")}catch{}})' 2>/dev/null || true)"
    if [ -n "$UNAME" ]; then set_env BOT_TOKEN "$TOK"; set_env BOT_USERNAME "$UNAME"; ok "验证通过：@$UNAME"; break; fi
    warn "token 无效或网络不可达（被墙？试 export HTTPS_PROXY=…）"
    [ "$_try" = 3 ] && die_fix "token 三次验证失败" "确认 token 正确、网络能访问 api.telegram.org"
  done
  echo
  info "AI 接口（OpenAI 兼容：OpenAI / Gemini 代理 / 自建 newapi 等）。填一个会自动铺到所有用途。"
  AI_EP="$(ask 'AI 接口地址 endpoint' 'https://api.openai.com/v1')"
  AI_KEY="$(ask_secret 'AI API key')"
  AI_MODEL="$(ask 'AI 模型' 'gpt-4o-mini')"
  for P in "${AI_PROVIDERS[@]}"; do
    set_env "AI_PROVIDER_${P}_ENDPOINT" "$AI_EP"
    set_env "AI_PROVIDER_${P}_KEY" "$AI_KEY"
    set_env "AI_PROVIDER_${P}_MODEL" "$AI_MODEL"
  done
  set_env NODE_ENV production
  rm -f .env.bak; trap - INT
  ok "已写入 .env（权限 600）"
fi
[ "$DRY" = 0 ] && mkdir -p logs data || true

# ── 3. 依赖 ──────────────────────────────────────────────────────────────────
if [ "$SKIP_DEPS" = 0 ]; then
  step "安装依赖" "首次较慢，原生模块要编译"
  if [ -f package-lock.json ]; then run npm ci --no-audit --no-fund || run npm install --no-audit --no-fund
  else run npm install --no-audit --no-fund; fi
  if [ "$MINIMAL" = 0 ] && [ -d miniapp-web ]; then run npm --prefix miniapp-web install --no-audit --no-fund || warn "miniapp 依赖装失败（不影响 bot 本体）"; fi
  # NyatDB native 的 @napi-rs/cli（devDep）；失败不挡主路径
  if [ -f native/nyatdb/package.json ]; then
    run bash -c 'cd native/nyatdb && NODE_ENV=development npm install --no-audit --no-fund' \
      || warn "NyatDB native 依赖装失败（可稍后 npm run build:nyatdb）"
  fi
  # 用户 clone、sudo 跑时，把 node_modules 还给该用户，免得之后 git pull/npm 报 EACCES
  if [ "$DRY" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
    chown -R "${SUDO_USER}:$(id -gn "$SUDO_USER" 2>/dev/null || echo "$SUDO_USER")" node_modules miniapp-web/node_modules native/nyatdb/node_modules 2>/dev/null || true
  fi
  ok "依赖就绪"
else step "安装依赖" "已跳过 (--skip-deps)"; fi

# ── 4. Qdrant 向量库 ─────────────────────────────────────────────────────────
if [ "$SKIP_QDRANT" = 0 ] && [ "$MINIMAL" = 0 ]; then
  step "Qdrant 向量库" "语义记忆存储"
  [ -n "${QDRANT_TARBALL:-}" ] && [ ! -f "${QDRANT_TARBALL}" ] && die_fix "QDRANT_TARBALL 文件不存在: $QDRANT_TARBALL" "检查路径，或不设此变量让脚本自动下载"
  if [ ! -x "$QDRANT_BIN" ] || ! "$QDRANT_BIN" --version 2>/dev/null | grep -qE "qdrant ${QDRANT_VERSION}([^0-9]|\$)"; then
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    if [ -n "${QDRANT_TARBALL:-}" ]; then cp "$QDRANT_TARBALL" "$tmp/q.tgz"; info "用本地包 $QDRANT_TARBALL"
    else
      url="https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}/qdrant-$(qdrant_arch).tar.gz"
      info "下载 qdrant ${QDRANT_VERSION}…"
      run curl -fsSL --connect-timeout 15 --retry 3 ${HTTPS_PROXY:+-x "$HTTPS_PROXY"} "$url" -o "$tmp/q.tgz" \
        || die_fix "Qdrant 下载失败（GitHub 被墙？）" "export HTTPS_PROXY=http://127.0.0.1:7890 后重跑，或手动下载 $url 再 QDRANT_TARBALL=/path sudo ./scripts/deploy.sh"
    fi
    [ "$DRY" = 0 ] && { tar xzf "$tmp/q.tgz" -C "$tmp" qdrant && install -m 755 "$tmp/qdrant" "$QDRANT_BIN"; }
    ok "已安装 $("$QDRANT_BIN" --version 2>/dev/null | head -1 || echo qdrant)"
  else ok "qdrant 已存在 ($("$QDRANT_BIN" --version 2>&1 | head -1))"; fi
  run mkdir -p "$QDRANT_STORAGE/storage" "$QDRANT_STORAGE/snapshots"
  if [ "$DRY" = 0 ]; then
    sed -e "s|__QDRANT_BIN__|${QDRANT_BIN}|g" -e "s|__STORAGE__|${QDRANT_STORAGE}|g" \
      "${ROOT_DIR}/deploy/systemd/qdrant.service.template" >/etc/systemd/system/qdrant.service
    systemctl daemon-reload; systemctl enable --now qdrant.service >/dev/null 2>&1 || systemctl restart qdrant.service
    for i in $(seq 1 20); do curl -fsS localhost:6333/healthz >/dev/null 2>&1 && break; [ "$i" = 20 ] && die_fix "Qdrant 20 秒内未就绪" "sudo journalctl -u qdrant -n 50 --no-pager"; sleep 1; done
  fi
  ok "qdrant 健康 (127.0.0.1:6333)"
else step "Qdrant 向量库" "已跳过（--skip-qdrant/--minimal，语义记忆将为空）"; fi

# ── 5. 构建 ──────────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = 0 ]; then
  step "构建" "约 1-3 分钟（含可选 NyatDB native）"
  [ "$MEM_MB" -lt 1800 ] && export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=1536"
  # PATH 可能刚装了 rustup
  # shellcheck disable=SC1090
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
  export PATH="${HOME}/.cargo/bin:${PATH}"
  if [ -f native/nyatdb/package.json ] && command -v cargo >/dev/null 2>&1; then
    run npm run build:nyatdb && ok "NyatDB native 已编译" \
      || warn "NyatDB native 编译失败 → 运行时用 TS 引擎（功能可用）。引擎源码：https://github.com/ZYHUO/nyatdb"
  elif [ -f native/nyatdb/package.json ]; then
    info "无 cargo，跳过 NyatDB native（需要时：装 Rust 后 npm run build:nyatdb）"
  fi
  run npm run build || die_fix "构建失败" "看上面的报错；内存小可加 swap 后重跑"
  if [ "$MINIMAL" = 0 ] && [ -d miniapp-web ]; then run npm run build:miniapp || warn "miniapp 构建失败（管理后台 UI 受影响，bot 本体不受影响）"; fi
  ok "构建完成 dist/"
else step "构建" "已跳过 (--skip-build)"; fi

# ── 6. systemd 服务 ──────────────────────────────────────────────────────────
step "安装 xxb-ts 服务" "开机自启 + 迁移自动应用"
run bash "${ROOT_DIR}/scripts/install-systemd.sh"
run systemctl enable xxb-ts.service >/dev/null 2>&1 || true
if [ "$NO_RESTART" = 0 ]; then run systemctl restart xxb-ts.service; ok "xxb-ts 已重启"
else warn "已跳过重启（--no-restart）：sudo systemctl restart xxb-ts"; fi

# ── 7. 自检（红绿灯）─────────────────────────────────────────────────────────
step "自检" "约 10 秒"
[ "$DRY" = 1 ] && { ok "dry-run 结束（未真正执行）"; exit 0; }
# 等 bot 起来：按当前 PID 在整份日志里找 "Bot started"（位置无关，不怕日志刷屏）
BOOTED=0
for _i in $(seq 1 20); do
  PID="$(systemctl show -p MainPID --value xxb-ts 2>/dev/null || echo 0)"
  if grep -q "\"pid\":${PID}[,}].*Bot started" logs/app.log 2>/dev/null; then BOOTED=1; break; fi
  # 兜底：pino-pretty(dev) 日志没有 JSON pid → 直接在最近行里找
  if tail -n 80 logs/app.log 2>/dev/null | grep -q 'Bot started'; then BOOTED=1; break; fi
  if journalctl -u xxb-ts -n 200 --no-pager 2>/dev/null | grep -q 'Bot started'; then BOOTED=1; break; fi
  sleep 1
done
REPORT="${ROOT_DIR}/deploy-report.txt"; PASS=0; FAIL=0
check() { local name="$1" cmd="$2"; if eval "$cmd" >/dev/null 2>&1; then printf "  ${C_G}✅ %s${C_0}\n" "$name"; PASS=$((PASS+1)); echo "OK  $name" >>"$REPORT.tmp"
  else printf "  ${C_R}❌ %s${C_0}\n" "$name"; FAIL=$((FAIL+1)); echo "FAIL $name" >>"$REPORT.tmp"; fi; }
: >"$REPORT.tmp"
check "Node ≥22"      "[ \"\$(node_major)\" -ge 22 ]"
check "Redis PING"    "redis-cli ping"
[ "$SKIP_QDRANT" = 0 ] && [ "$MINIMAL" = 0 ] && check "Qdrant 健康" "curl -fsS localhost:6333/healthz"
check "xxb-ts 运行中"  "systemctl is-active --quiet xxb-ts"
check "Bot 已启动"     "[ \"\$BOOTED\" = 1 ]"
{ echo "NyatBot deploy report  $(date)"; echo "node=$(node -v 2>/dev/null) arch=$(uname -m) mem=${MEM_MB}MB"; cat "$REPORT.tmp"; } >"$REPORT"; rm -f "$REPORT.tmp"

echo
if [ "$FAIL" = 0 ]; then
  printf "${C_G}  🎉 全部通过！机器人已上线。${C_0}\n"
  info "去 Telegram 把它拉进群试试。日志：tail -f ${ROOT_DIR}/logs/app.log"
  info "首次用到长期记忆会从 HuggingFace 拉嵌入模型(~23MB)；国内卡住可设 HF_ENDPOINT=https://hf-mirror.com"
  EXIT_CODE=0
else
  printf "${C_Y}  有 %d 项没通过。${C_0}\n" "$FAIL"
  info "体检：sudo ./scripts/deploy.sh --doctor   ·   重填配置：sudo ./scripts/deploy.sh --reconfigure"
  info "排错：sudo journalctl -u xxb-ts -n 80 --no-pager   或   tail -50 ${ROOT_DIR}/logs/app.log"
  LASTERR="$({ tail -n 40 logs/app.log 2>/dev/null; journalctl -u xxb-ts -n 40 --no-pager 2>/dev/null; } | tail -20 || true)"
  case "$LASTERR" in
    *ECONNREFUSED*6379*|*redis*) warn "像是 Redis 没连上：sudo systemctl enable --now redis-server" ;;
    *401*|*Unauthorized*|*api*key*|*invalid*key*) warn "像是 AI key 不对：sudo ./scripts/deploy.sh --reconfigure" ;;
    *BOT_TOKEN*|*Unauthorized*40[13]*) warn "像是 BOT_TOKEN 不对：sudo ./scripts/deploy.sh --reconfigure" ;;
    *ZodError*|*env*) warn "像是 .env 配置缺项：按报错字段补全 .env" ;;
  esac
  info "求助时把这个文件发出来（不含密钥）：$REPORT"
  EXIT_CODE=1
fi
echo
info "管理：systemctl {status,restart,stop} xxb-ts · systemctl status qdrant · 更新：sudo ./scripts/deploy.sh --update"
exit "$EXIT_CODE"
