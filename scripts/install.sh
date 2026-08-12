#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
#  🐱 NyatBot — 交互式安装向导
#
#  从零到机器人跑起来：环境检查 → 填配置（bot token / AI / 主人 / 功能开关）→
#  依赖 →（可选）NyatDB native（需 Rust；https://github.com/ZYHUO/nyatdb）→ 构建 →
#  systemd → 自检。幂等，可反复执行。NyatDB 默认关（.env.example NYATDB_*）。
#
#  用法：
#    sudo ./scripts/install.sh                全新安装（交互引导）
#    sudo ./scripts/install.sh --update       快速更新：git pull + 重建(+nyatdb) + 重启
#    sudo ./scripts/install.sh --doctor       只体检，不改任何东西
#    sudo ./scripts/install.sh --uninstall    停服并卸载（保留数据）
#    sudo ./scripts/install.sh --reconfigure  只重填配置
#
#  标志：--yes(非交互默认) --china(国内镜像) --minimal(低内存) --skip-qdrant
#        --skip-build --no-restart --no-color
#  环境：QDRANT_VERSION · QDRANT_TARBALL · HTTPS_PROXY
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT_DIR"
QDRANT_VERSION="${QDRANT_VERSION:-1.18.1}"
QDRANT_BIN="/usr/local/bin/qdrant"
QDRANT_STORAGE="${ROOT_DIR}/data/qdrant"

[ -f "$ROOT_DIR/package.json" ] || { echo "找不到项目根，请 git clone 后 cd 进去运行" >&2; exit 1; }

DRY=0; YES=0; CHINA=0; MINIMAL=0; DOCTOR=0; UNINSTALL=0; UPDATE=0; RECONFIG=0
SKIP_QDRANT=0; SKIP_BUILD=0; NO_RESTART=0; COLOR=1
for a in "$@"; do case "$a" in
  --dry-run) DRY=1 ;; --yes|-y) YES=1 ;; --china) CHINA=1 ;; --minimal) MINIMAL=1 ;;
  --doctor) DOCTOR=1 ;; --uninstall) UNINSTALL=1 ;; --update) UPDATE=1 ;;
  --reconfigure) RECONFIG=1 ;;
  --skip-qdrant) SKIP_QDRANT=1 ;; --skip-build) SKIP_BUILD=1 ;;
  --no-restart) NO_RESTART=1 ;; --no-color) COLOR=0 ;;
  -h|--help) sed -n '2,25p' "$0" | sed 's/^#\s\?//'; exit 0 ;;
  *) echo "未知参数: $a （--help 看用法）" >&2; exit 2 ;;
esac; done
[ -t 1 ] || COLOR=0

# ── UI helpers ───────────────────────────────────────────────────────────────
if [ "$COLOR" = 1 ]; then
  C_B='\033[1;36m'; C_G='\033[1;32m'; C_Y='\033[1;33m'; C_R='\033[1;31m'; C_D='\033[2m'; C_0='\033[0m'
else C_B=''; C_G=''; C_Y=''; C_R=''; C_D=''; C_0=''; fi
STEP=0; TOTAL=8
step() { STEP=$((STEP + 1)); printf "\n${C_B}[%d/%d] %s${C_0}  ${C_D}%s${C_0}\n" "$STEP" "$TOTAL" "$1" "${2:-}"; }
ok()   { printf "  ${C_G}✓${C_0} %s\n" "$*"; }
warn() { printf "  ${C_Y}!${C_0} %s\n" "$*"; }
info() { printf "  ${C_D}%s${C_0}\n" "$*"; }
die_fix() { printf "\n  ${C_R}✗ %s${C_0}\n  ${C_D}修复:${C_0} %s\n" "$1" "$2" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf "  ${C_D}+ %s${C_0}\n" "$*"; else "$@"; fi; }

ask() {
  local p="$1" d="${2:-}" v
  if [ "$YES" = 1 ]; then printf '%s' "$d"; return; fi
  read -r -p "  $p${d:+ [$d]}: " v </dev/tty || true
  printf '%s' "${v:-$d}"
}
ask_secret() {
  local p="$1" v
  if [ "$YES" = 1 ]; then return; fi
  read -r -s -p "  $p: " v </dev/tty || true
  echo >/dev/tty
  printf '%s' "$v"
}
ask_bool() {
  local p="$1" d="${2:-n}" v
  if [ "$YES" = 1 ]; then [ "$d" = y ] && return 0 || return 1; fi
  read -r -p "  $p [${d}/$( [ "$d" = y ] && echo n || echo y )] " v </dev/tty || true
  [ "${v:-$d}" = y ]
}
confirm() { ask_bool "$@"; }

banner() {
  printf "${C_B}"
  cat <<'EOF'
  ╔══════════════════════════════════════════╗
  ║   🐱  NyatBot 安装向导                    ║
  ║   Telegram AI 群聊喵娘机器人              ║
  ╚══════════════════════════════════════════╝
EOF
  printf "${C_0}"
}

# ── .env 操作 ────────────────────────────────────────────────────────────────
# 幂等写 .env：删旧行 + 追加新行，保 600 权限
set_env() {
  local k="$1" v="$2" tmp; tmp="$(mktemp)"
  grep -v "^${k}=" .env >"$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$k" "$v" >>"$tmp"
  install -m 600 "$tmp" .env; rm -f "$tmp"
}

# 读 .env 当前值（不存在返回空）
get_env() {
  grep -m1 "^$1=" .env 2>/dev/null | cut -d= -f2- || true
}

# ── node resolution ──────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  SUH="$(getent passwd "${SUDO_USER:-}" 2>/dev/null | cut -d: -f6 || true)"
  N="$(ls -d /root/.local/share/fnm/node-versions/*/installation/bin/node \
        "$HOME"/.nvm/versions/node/*/bin/node \
        ${SUH:+"$SUH"/.nvm/versions/node/*/bin/node} \
        ${SUH:+"$SUH"/.local/share/fnm/node-versions/*/installation/bin/node} 2>/dev/null | sort -V | tail -1 || true)"
  [ -n "${N:-}" ] && export PATH="$(dirname "$N"):$PATH"
fi
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

detect_pm() { for p in apt-get dnf yum zypper pacman; do command -v "$p" >/dev/null 2>&1 && { echo "$p"; return; }; done; return 1; }
qdrant_arch() { case "$(uname -m)" in
  x86_64|amd64) echo x86_64-unknown-linux-musl ;;
  aarch64|arm64) echo aarch64-unknown-linux-musl ;;
  *) die_fix "CPU 架构 $(uname -m) 不支持" "换 x86_64 / ARM64 机器，或用 Docker 部署" ;;
esac; }

# ─────────────────────────────────────────────────────────────────────────────
#  --doctor : 只读体检
# ─────────────────────────────────────────────────────────────────────────────
if [ "$DOCTOR" = 1 ]; then
  banner; echo "  体检（只读，不改动）"
  printf "  node:     %s\n" "$(command -v node >/dev/null && node -v || echo '未安装')"
  printf "  redis:    %s\n" "$(redis-cli ping 2>/dev/null || echo '不可达')"
  printf "  qdrant:   %s (%s)\n" "$(systemctl is-active qdrant 2>/dev/null || echo n/a)" "$(curl -fsS localhost:6333/healthz 2>/dev/null || echo no-health)"
  printf "  nyatbot:  %s\n" "$(systemctl is-active nyatbot 2>/dev/null || echo n/a)"
  printf "  cargo:    %s\n" "$(command -v cargo >/dev/null && rustc --version 2>/dev/null || echo '未安装（NyatDB 可用 TS 引擎）')"
  if ls native/nyatdb/*.node >/dev/null 2>&1; then printf "  nyatdb:   native addon 已编译 (%s)\n" "$(ls native/nyatdb/*.node 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
  else printf "  nyatdb:   无 native .node（默认关；引擎 https://github.com/ZYHUO/nyatdb ）\n"; fi
  printf "  内存:     %s | 磁盘: %s\n" "$(free -h | awk 'NR==2{print $7" 可用"}')" "$(df -h "$ROOT_DIR" | awk 'NR==2{print $4" 可用"}')"
  printf "  master:   %s\n" "$(get_env MASTER_UID)"
  printf "  bot:      @%s\n" "$(get_env BOT_USERNAME)"
  echo "  最近日志:"; { tail -n 15 logs/app.log 2>/dev/null || journalctl -u nyatbot -n 15 --no-pager 2>/dev/null; } | sed 's/^/    /'
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
#  --uninstall : 停服并移除（保留数据）
# ─────────────────────────────────────────────────────────────────────────────
if [ "$UNINSTALL" = 1 ]; then
  banner; confirm "停止并卸载 nyatbot + qdrant 服务？（数据保留在 data/）" || exit 0
  run systemctl disable --now nyatbot.service 2>/dev/null || true
  run systemctl disable --now xxb-ts.service 2>/dev/null || true  # 兼容旧服务名
  run systemctl disable --now qdrant.service 2>/dev/null || true
  run rm -f /etc/systemd/system/nyatbot.service /etc/systemd/system/xxb-ts.service /etc/systemd/system/qdrant.service
  run systemctl daemon-reload
  ok "已停服并移除。数据仍在 ${ROOT_DIR}/data"
  exit 0
fi

[ "$(id -u)" = 0 ] || die_fix "需要 root 权限" "sudo ./scripts/install.sh"

# ─────────────────────────────────────────────────────────────────────────────
#  --update : 快速更新
# ─────────────────────────────────────────────────────────────────────────────
if [ "$UPDATE" = 1 ]; then
  banner; step "更新代码并重启" "git pull · 重建 · 重启"
  if [ -d .git ]; then run git pull --ff-only || die_fix "git pull 失败" "git stash 或 git reset --hard origin/main 后重跑"
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
  if [ "$NO_RESTART" = 1 ] || [ "$DRY" = 1 ]; then ok "已更新（未重启）"; exit 0; fi
  # 兼容旧服务名
  if systemctl list-unit-files | grep -q 'xxb-ts.service'; then
    run systemctl restart xxb-ts.service; sleep 5
    systemctl is-active --quiet xxb-ts && ok "已更新并重启 (xxb-ts)" || die_fix "重启后未运行" "sudo journalctl -u xxb-ts -n 80"
  else
    run systemctl restart nyatbot.service; sleep 5
    systemctl is-active --quiet nyatbot && ok "已更新并重启 (nyatbot)" || die_fix "重启后未运行" "sudo journalctl -u nyatbot -n 80"
  fi
  exit 0
fi

banner

# ── 1. 环境预检 ──────────────────────────────────────────────────────────────
step "环境预检" "约 10 秒"
command -v systemctl >/dev/null || die_fix "没有 systemd（容器/OpenVZ？）" "请用 Docker 部署"
qdrant_arch >/dev/null
ok "架构 $(uname -m)"

# Node 22
if [ "$(node_major)" -ge 22 ]; then ok "node $(node -v)"; else
  warn "需要 Node.js ≥ 22（当前: $(command -v node >/dev/null && node -v || echo 无)）"
  if pm="$(detect_pm)" && confirm "自动安装 Node 22？"; then
    case "$pm" in
      apt-get) run apt-get update -y; run apt-get install -y ca-certificates curl gnupg
               run bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'; run apt-get install -y nodejs ;;
      dnf|yum) run bash -c 'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -'; run "$pm" install -y nodejs ;;
      *) die_fix "此系统无法自动装 Node 22" "手动安装后重跑" ;;
    esac
    [ "$(node_major)" -ge 22 ] || die_fix "Node 22 安装后仍不可用" "检查 node -v"
    ok "node $(node -v)"
  else die_fix "缺少 Node.js ≥ 22" "安装 Node 22+ 后重跑"; fi
fi

# 编译工具（better-sqlite3 + 可选 NyatDB Rust addon）
if command -v g++ >/dev/null && command -v python3 >/dev/null && command -v make >/dev/null; then ok "编译工具齐全"
else
  warn "缺少编译工具（better-sqlite3 需要）"
  if pm="$(detect_pm)" && confirm "自动安装？"; then
    case "$pm" in apt-get) run apt-get update -y; run apt-get install -y build-essential python3 ;;
      dnf|yum) run "$pm" groupinstall -y "Development Tools"; run "$pm" install -y python3 ;;
      *) warn "请手动安装" ;; esac
  fi
fi

# Rust（可选：NyatDB native；缺省则走 TS 引擎）
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

# 内存
MEM_KB="$(grep -m1 MemAvailable /proc/meminfo 2>/dev/null | awk '{print $2}')"; [[ "$MEM_KB" =~ ^[0-9]+$ ]] || MEM_KB=0
MEM_MB=$(( MEM_KB / 1024 ))
if [ "$MEM_MB" != 0 ] && [ "$MEM_MB" -lt 1800 ]; then
  warn "可用内存约 ${MEM_MB}MB —— 编译/运行可能被 Killed"
  if ! swapon --show 2>/dev/null | grep -q .; then
    warn "建议加 2G swap：sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile"
  fi
elif [ "$MEM_MB" != 0 ]; then ok "内存 ${MEM_MB}MB 可用"; fi

# Redis
if redis-cli ping >/dev/null 2>&1; then ok "redis 已就绪"
elif systemctl list-unit-files 2>/dev/null | grep -qE '^redis(-server)?\.service'; then
  run systemctl enable --now redis-server.service 2>/dev/null || run systemctl enable --now redis.service || true
  sleep 1; redis-cli ping >/dev/null 2>&1 && ok "redis 已启动" || die_fix "redis 未能启动" "sudo systemctl status redis-server"
elif pm="$(detect_pm)" && confirm "未检测到 Redis（队列必需），自动安装？"; then
  case "$pm" in apt-get) run apt-get update -y; run apt-get install -y redis-server; run systemctl enable --now redis-server ;;
    dnf|yum) run "$pm" install -y redis; run systemctl enable --now redis ;;
    *) die_fix "请手动安装 Redis" "装好后重跑" ;; esac
  redis-cli ping >/dev/null 2>&1 && ok "redis 已就绪" || die_fix "redis 安装后不可达" "sudo systemctl status redis-server"
else die_fix "Redis 不可达（队列必需）" "sudo apt install -y redis-server && sudo systemctl enable --now redis-server"; fi

if [ "$CHINA" = 1 ]; then
  run npm config set registry https://registry.npmmirror.com
  info "已切 npm 淘宝镜像。GitHub/Telegram/AI 端点如被墙，请 export HTTPS_PROXY=…"
fi

# ── 2. Bot 基本配置 ──────────────────────────────────────────────────────────
step "Bot 基本配置" "填 Telegram bot token"
[ -s .env ] || install -m 600 .env.example .env

TOKEN_OK=1
CUR_TOKEN="$(get_env BOT_TOKEN)"
[ -z "$CUR_TOKEN" ] && TOKEN_OK=0
echo "$CUR_TOKEN" | grep -qE '^([[:space:]]*$|your|123456:|\*)' && TOKEN_OK=0
[ "$RECONFIG" = 1 ] && TOKEN_OK=0

if [ "$TOKEN_OK" = 1 ]; then
  ok "BOT_TOKEN 已配置 (@$(get_env BOT_USERNAME))"
elif [ "$DRY" = 1 ]; then
  ok "(dry-run) 这里会交互引导填 BOT_TOKEN"
elif [ "$YES" = 1 ] || ! { : >/dev/tty; } 2>/dev/null; then
  die_fix "尚未配置 BOT_TOKEN" "编辑 $(pwd)/.env 填好，或在交互终端运行（ssh 加 -t）"
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
fi

# Bot 昵称
CUR_NICK="$(get_env BOT_NICKNAMES)"
if [ -z "$CUR_NICK" ] || [ "$RECONFIG" = 1 ]; then
  NICK="$(ask 'Bot 昵称（逗号分隔，群友@用的名字）' "${CUR_NICK:-啾咪囝,啾咪}")"
  set_env BOT_NICKNAMES "$NICK"
fi
ok "Bot 昵称: $(get_env BOT_NICKNAMES)"

# ── 3. 主人配置 ──────────────────────────────────────────────────────────────
step "主人配置" "你的 Telegram 用户 ID"
CUR_MASTER="$(get_env MASTER_UID)"
if [ -z "$CUR_MASTER" ] || [ "$CUR_MASTER" = "0" ] || [ "$RECONFIG" = 1 ]; then
  info "主人 UID 是你的 Telegram 数字 ID（不是 username）。"
  info "获取方法：给 @userinfobot 发消息，或 @getmyid_bot"
  for _try in 1 2 3; do
    MUID="$(ask '你的 Telegram 用户 ID（数字）' "${CUR_MASTER:-}")"
    if echo "$MUID" | grep -qE '^[0-9]+$' && [ "$MUID" -gt 0 ] 2>/dev/null; then
      set_env MASTER_UID "$MUID"; ok "主人 UID: $MUID"; break
    fi
    warn "请输入纯数字 ID"
    [ "$_try" = 3 ] && die_fix "主人 UID 无效" "必须是纯数字（如 6251541967）"
  done
else
  ok "主人 UID: $CUR_MASTER"
fi

# 额外主人（多管理员）
CUR_EXTRA="$(get_env MASTER_UID_EXTRA)"
if [ "$RECONFIG" = 1 ]; then
  EXTRA="$(ask '额外管理员 UID（逗号分隔，留空跳过）' "$CUR_EXTRA")"
  [ -n "$EXTRA" ] && set_env MASTER_UID_EXTRA "$EXTRA" || set_env MASTER_UID_EXTRA ""
elif [ -n "$CUR_EXTRA" ]; then
  ok "额外管理员: $CUR_EXTRA"
fi

# ── 4. AI 模型配置 ───────────────────────────────────────────────────────────
step "AI 模型配置" "OpenAI 兼容接口（可分开配置不同用途）"

AI_OK=1
CUR_AI_KEY="$(get_env AI_PROVIDER_REPLY_KEY)"
echo "$CUR_AI_KEY" | grep -qE '^([[:space:]]*$|\*\*\*|your)' && AI_OK=0
[ "$RECONFIG" = 1 ] && AI_OK=0

if [ "$AI_OK" = 1 ]; then
  ok "AI 已配置（endpoint: $(get_env AI_PROVIDER_REPLY_ENDPOINT)）"
elif [ "$DRY" = 1 ]; then
  ok "(dry-run) 这里会交互引导填 AI 接口"
elif [ "$YES" = 1 ] || ! { : >/dev/tty; } 2>/dev/null; then
  die_fix "尚未配置 AI 接口" "编辑 $(pwd)/.env 填好 AI_PROVIDER_* 后重跑"
else
  echo
  info "AI 接口（OpenAI 兼容：OpenAI / DeepSeek / Kimi / GLM / 自建 newapi 等）"
  echo

  # 快速模式 vs 分开配置
  if confirm "所有用途用同一个 AI 接口？（选 n 可以 reply/judge 分开配）" "y"; then
    AI_EP="$(ask 'AI 接口地址 endpoint' "$(get_env AI_PROVIDER_REPLY_ENDPOINT || echo 'https://api.openai.com/v1')")"
    AI_KEY="$(ask_secret 'AI API key')"
    AI_MODEL="$(ask 'AI 模型' "$(get_env AI_PROVIDER_REPLY_MODEL || echo 'gpt-4o-mini')")"
    for P in REPLY VISION JUDGE SUMMARIZE ALLOWLIST_REVIEW; do
      set_env "AI_PROVIDER_${P}_ENDPOINT" "$AI_EP"
      set_env "AI_PROVIDER_${P}_KEY" "$AI_KEY"
      set_env "AI_PROVIDER_${P}_MODEL" "$AI_MODEL"
    done
  else
    echo
    info "--- 主回复模型（reply）--- 聊天质量靠它，建议用好的"
    AI_EP="$(ask 'reply endpoint' "$(get_env AI_PROVIDER_REPLY_ENDPOINT || echo 'https://api.openai.com/v1')")"
    AI_KEY="$(ask_secret 'reply API key')"
    AI_MODEL="$(ask 'reply 模型' "$(get_env AI_PROVIDER_REPLY_MODEL || echo 'gpt-4o')")"
    set_env AI_PROVIDER_REPLY_ENDPOINT "$AI_EP"
    set_env AI_PROVIDER_REPLY_KEY "$AI_KEY"
    set_env AI_PROVIDER_REPLY_MODEL "$AI_MODEL"

    echo
    info "--- 判断/摘要模型（judge/summarize）--- 走量，便宜的就行"
    J_EP="$(ask 'judge endpoint' "$AI_EP")"
    J_KEY="$(ask_secret 'judge API key（回车同上）')"
    J_KEY="${J_KEY:-$AI_KEY}"
    J_MODEL="$(ask 'judge 模型' 'gpt-4o-mini')"
    set_env AI_PROVIDER_JUDGE_ENDPOINT "$J_EP"
    set_env AI_PROVIDER_JUDGE_KEY "$J_KEY"
    set_env AI_PROVIDER_JUDGE_MODEL "$J_MODEL"
    set_env AI_PROVIDER_SUMMARIZE_ENDPOINT "$J_EP"
    set_env AI_PROVIDER_SUMMARIZE_KEY "$J_KEY"
    set_env AI_PROVIDER_SUMMARIZE_MODEL "$J_MODEL"

    echo
    info "--- 视觉模型（vision）--- 识图用"
    V_EP="$(ask 'vision endpoint' "$AI_EP")"
    V_KEY="$(ask_secret 'vision API key（回车同上）')"
    V_KEY="${V_KEY:-$AI_KEY}"
    V_MODEL="$(ask 'vision 模型' "$AI_MODEL")"
    set_env AI_PROVIDER_VISION_ENDPOINT "$V_EP"
    set_env AI_PROVIDER_VISION_KEY "$V_KEY"
    set_env AI_PROVIDER_VISION_MODEL "$V_MODEL"
    set_env AI_PROVIDER_ALLOWLIST_REVIEW_ENDPOINT "$J_EP"
    set_env AI_PROVIDER_ALLOWLIST_REVIEW_KEY "$J_KEY"
    set_env AI_PROVIDER_ALLOWLIST_REVIEW_MODEL "$J_MODEL"
  fi

  # Usage 路由
  set_env AI_USAGE_REPLY_LABEL reply
  set_env AI_USAGE_VISION_LABEL vision
  set_env AI_USAGE_JUDGE_LABEL judge
  set_env AI_USAGE_SUMMARIZE_LABEL summarize
  set_env NODE_ENV production
fi

# ── 5. 功能开关 ──────────────────────────────────────────────────────────────
step "功能开关" "选要开的功能（都可以后改）"

if [ "$RECONFIG" = 1 ] || [ -z "$(get_env DREAM_JOURNAL_ENABLED)" ]; then
  echo
  info "以下功能全部默认关，选 y 开启。之后随时可改 .env 重启生效。"

  # 日记系统
  if confirm "开启梦境日记？（bot 定期写日记，可发到频道）" "n"; then
    set_env DREAM_JOURNAL_ENABLED true
    DJ_CHAT="$(ask '日记频道 ID（纯数字，留空不发频道）' "$(get_env DREAM_JOURNAL_CHAT_ID)")"
    [ -n "$DJ_CHAT" ] && set_env DREAM_JOURNAL_CHAT_ID "$DJ_CHAT"
    if confirm "写完日记私聊推给你？" "y"; then
      set_env DREAM_JOURNAL_DM true
    else
      set_env DREAM_JOURNAL_DM false
    fi
  else
    set_env DREAM_JOURNAL_ENABLED false
  fi

  # 心情系统
  if confirm "开启心情系统？（bot 对每个群有独立情绪，影响语气）" "n"; then
    set_env MOOD_ENABLED true
    set_env MOOD_INJECT_ENABLED true
  else
    set_env MOOD_ENABLED false
    set_env MOOD_INJECT_ENABLED false
  fi

  # 自我记忆
  if confirm "开启自我记忆？（bot 记得自己说过什么，防前后矛盾）" "n"; then
    set_env SELF_HISTORY_ENABLED true
  else
    set_env SELF_HISTORY_ENABLED false
  fi

  # 关系叙事
  if confirm "开启关系叙事？（老朋友更亲昵，反感偏冷淡）" "n"; then
    set_env RELATIONSHIP_ENABLED true
  else
    set_env RELATIONSHIP_ENABLED false
  fi

  # 长期记忆
  if [ "$SKIP_QDRANT" = 0 ] && [ "$MINIMAL" = 0 ]; then
    if confirm "开启长期记忆？（语义搜索群聊记录，需要 Qdrant 向量库）" "y"; then
      : # Qdrant 默认装，不用额外 flag
    else
      SKIP_QDRANT=1
      info "跳过 Qdrant，语义记忆将为空"
    fi
  fi

  # 记忆去重
  if [ "$SKIP_QDRANT" = 0 ]; then
    if confirm "开启记忆去重？（相似度 >0.93 的近重复记忆合并）" "n"; then
      set_env MEMORY_DEDUP_ENABLED true
    fi
  fi

  # 频道消息源
  CH_SRC="$(ask '频道消息源 ID（逗号分隔负数 ID，bot 需是频道管理员，留空跳过）' "$(get_env CHANNEL_SOURCE_IDS)")"
  [ -n "$CH_SRC" ] && set_env CHANNEL_SOURCE_IDS "$CH_SRC"

  # 主动发言
  if confirm "允许 bot 主动开口？（群冷场时偶尔冒泡）" "n"; then
    set_env JUDGE_PROACTIVE_ENABLED true
  else
    set_env JUDGE_PROACTIVE_ENABLED false
  fi
fi

# ── 6. 依赖 ──────────────────────────────────────────────────────────────────
step "安装依赖" "首次较慢，原生模块要编译"
if [ -f package-lock.json ]; then run npm ci --no-audit --no-fund || run npm install --no-audit --no-fund
else run npm install --no-audit --no-fund; fi
# NyatDB native 的 @napi-rs/cli（devDep）；失败不挡主路径
if [ -f native/nyatdb/package.json ]; then
  run bash -c 'cd native/nyatdb && NODE_ENV=development npm install --no-audit --no-fund' \
    || warn "NyatDB native 依赖装失败（可稍后 npm run build:nyatdb）"
fi
if [ "$DRY" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
  chown -R "${SUDO_USER}:$(id -gn "$SUDO_USER" 2>/dev/null || echo "$SUDO_USER")" node_modules native/nyatdb/node_modules 2>/dev/null || true
fi
ok "依赖就绪"

# ── 7. Qdrant 向量库 ─────────────────────────────────────────────────────────
if [ "$SKIP_QDRANT" = 0 ] && [ "$MINIMAL" = 0 ]; then
  step "Qdrant 向量库" "语义记忆存储"
  if [ ! -x "$QDRANT_BIN" ] || ! "$QDRANT_BIN" --version 2>/dev/null | grep -qE "qdrant ${QDRANT_VERSION}([^0-9]|\$)"; then
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    if [ -n "${QDRANT_TARBALL:-}" ]; then cp "$QDRANT_TARBALL" "$tmp/q.tgz"; info "用本地包 $QDRANT_TARBALL"
    else
      url="https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}/qdrant-$(qdrant_arch).tar.gz"
      info "下载 qdrant ${QDRANT_VERSION}…"
      run curl -fsSL --connect-timeout 15 --retry 3 ${HTTPS_PROXY:+-x "$HTTPS_PROXY"} "$url" -o "$tmp/q.tgz" \
        || die_fix "Qdrant 下载失败" "export HTTPS_PROXY=http://127.0.0.1:7890 后重跑，或 QDRANT_TARBALL=/path sudo ./scripts/install.sh"
    fi
    [ "$DRY" = 0 ] && { tar xzf "$tmp/q.tgz" -C "$tmp" qdrant && install -m 755 "$tmp/qdrant" "$QDRANT_BIN"; }
    ok "已安装 $("$QDRANT_BIN" --version 2>/dev/null | head -1 || echo qdrant)"
  else ok "qdrant 已存在"; fi
  run mkdir -p "$QDRANT_STORAGE/storage" "$QDRANT_STORAGE/snapshots"
  if [ "$DRY" = 0 ]; then
    sed -e "s|__QDRANT_BIN__|${QDRANT_BIN}|g" -e "s|__STORAGE__|${QDRANT_STORAGE}|g" \
      "${ROOT_DIR}/deploy/systemd/qdrant.service.template" >/etc/systemd/system/qdrant.service
    systemctl daemon-reload; systemctl enable --now qdrant.service >/dev/null 2>&1 || systemctl restart qdrant.service
    for i in $(seq 1 20); do curl -fsS localhost:6333/healthz >/dev/null 2>&1 && break; [ "$i" = 20 ] && die_fix "Qdrant 20 秒内未就绪" "sudo journalctl -u qdrant -n 50"; sleep 1; done
  fi
  ok "qdrant 健康 (127.0.0.1:6333)"
else step "Qdrant 向量库" "已跳过"; fi

# ── 8. 构建 + systemd + 自检 ────────────────────────────────────────────────
if [ "$SKIP_BUILD" = 0 ]; then
  step "构建" "约 1-3 分钟（含可选 NyatDB native）"
  [ "$MEM_MB" -lt 1800 ] && export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=1536"
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
  ok "构建完成 dist/"
else step "构建" "已跳过"; fi

step "安装服务" "开机自启 + 迁移自动应用"
# 兼容旧服务名：先停旧的
if systemctl list-unit-files | grep -q 'xxb-ts.service'; then
  run bash "${ROOT_DIR}/scripts/install-systemd.sh"
  run systemctl enable xxb-ts.service >/dev/null 2>&1 || true
  SVC_NAME="xxb-ts"
else
  run bash "${ROOT_DIR}/scripts/install-systemd.sh"
  run systemctl enable nyatbot.service >/dev/null 2>&1 || run systemctl enable xxb-ts.service >/dev/null 2>&1 || true
  SVC_NAME="$(systemctl list-unit-files | grep -oE '(nyatbot|xxb-ts)\.service' | head -1 | sed 's/\.service//')"
fi
if [ "$NO_RESTART" = 0 ]; then
  run systemctl restart "$SVC_NAME"
  ok "$SVC_NAME 已重启"
else warn "已跳过重启：sudo systemctl restart $SVC_NAME"; fi

step "自检" "约 10 秒"
[ "$DRY" = 1 ] && { ok "dry-run 结束"; exit 0; }

BOOTED=0
for _i in $(seq 1 20); do
  PID="$(systemctl show -p MainPID --value "$SVC_NAME" 2>/dev/null || echo 0)"
  if grep -q "\"pid\":${PID}[,}].*Bot started" logs/app.log 2>/dev/null; then BOOTED=1; break; fi
  if tail -n 80 logs/app.log 2>/dev/null | grep -q 'Bot started'; then BOOTED=1; break; fi
  if journalctl -u "$SVC_NAME" -n 200 --no-pager 2>/dev/null | grep -q 'Bot started'; then BOOTED=1; break; fi
  sleep 1
done

REPORT="${ROOT_DIR}/deploy-report.txt"; PASS=0; FAIL=0
check() { local name="$1" cmd="$2"; if eval "$cmd" >/dev/null 2>&1; then
  printf "  ${C_G}✅ %s${C_0}\n" "$name"; PASS=$((PASS+1)); echo "OK  $name" >>"$REPORT.tmp"
else printf "  ${C_R}❌ %s${C_0}\n" "$name"; FAIL=$((FAIL+1)); echo "FAIL $name" >>"$REPORT.tmp"; fi; }
: >"$REPORT.tmp"
check "Node ≥22"      "[ \"$(node_major)\" -ge 22 ]"
check "Redis PING"    "redis-cli ping"
[ "$SKIP_QDRANT" = 0 ] && [ "$MINIMAL" = 0 ] && check "Qdrant 健康" "curl -fsS localhost:6333/healthz"
check "$SVC_NAME 运行中" "systemctl is-active --quiet $SVC_NAME"
check "Bot 已启动"     "[ \"$BOOTED\" = 1 ]"
{ echo "NyatBot install report  $(date)"; echo "node=$(node -v 2>/dev/null) arch=$(uname -m) mem=${MEM_MB}MB"; cat "$REPORT.tmp"; } >"$REPORT"; rm -f "$REPORT.tmp"

echo
if [ "$FAIL" = 0 ]; then
  printf "${C_G}  🎉 全部通过！机器人已上线。${C_0}\n"
  info "去 Telegram 把它拉进群试试。日志：tail -f ${ROOT_DIR}/logs/app.log"
  info "首次用到长期记忆会从 HuggingFace 拉嵌入模型(~23MB)；国内卡住可设 HF_ENDPOINT=https://hf-mirror.com"
  EXIT_CODE=0
else
  printf "${C_Y}  有 %d 项没通过。${C_0}\n" "$FAIL"
  info "体检：sudo ./scripts/install.sh --doctor   ·   重填配置：sudo ./scripts/install.sh --reconfigure"
  info "排错：sudo journalctl -u $SVC_NAME -n 80 --no-pager   或   tail -50 ${ROOT_DIR}/logs/app.log"
  EXIT_CODE=1
fi

echo
info "管理：systemctl {status,restart,stop} $SVC_NAME · 更新：sudo ./scripts/install.sh --update"
info "改配置：nano .env → sudo systemctl restart $SVC_NAME"
exit "$EXIT_CODE"
