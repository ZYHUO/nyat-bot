#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
#  🐱 NyatBot 一键安装 (bootstrap)
#
#    curl -fsSL https://raw.githubusercontent.com/ZYHUO/nyat-bot/main/install.sh | sudo bash
#
#  它负责：装 git → 拉源码 → 交给安装向导 scripts/install.sh（交互填配置，全自动）。
#  向导可可选安装 Rust 并编译 NyatDB native（https://github.com/ZYHUO/nyatdb ，公开仓库）；
#  不装 Rust 则用 TS 引擎。NyatDB 默认关，见 .env.example 的 NYATDB_*。
#
#  传参（注意管道形式要用 `-s --`）：
#    curl -fsSL .../install.sh | sudo bash -s -- --china        # 国内镜像
#    curl -fsSL .../install.sh | sudo bash -s -- --update       # 已装过→更新
#  可调环境变量：
#    NYATBOT_DIR   安装目录（默认 /opt/nyatbot）
#    NYATBOT_REPO  仓库地址（默认 GitHub；国内可换 gitee/ghproxy 镜像）
#    NYATBOT_BRANCH 分支（默认 main）
#    HTTPS_PROXY   代理（git/curl 都认）
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO="${NYATBOT_REPO:-https://github.com/ZYHUO/nyat-bot.git}"
DIR="${NYATBOT_DIR:-/opt/nyatbot}"
BRANCH="${NYATBOT_BRANCH:-main}"

if [ -t 1 ]; then B='\033[1;36m'; G='\033[1;32m'; Y='\033[1;33m'; R='\033[1;31m'; Z='\033[0m'; else B=''; G=''; Y=''; R=''; Z=''; fi
say()  { printf "${B}▶ %s${Z}\n" "$*"; }
ok()   { printf "  ${G}✓${Z} %s\n" "$*"; }
die()  { printf "  ${R}✗ %s${Z}\n" "$*" >&2; exit 1; }

printf "${B}"
cat <<'EOF'
  ╔══════════════════════════════════════════╗
  ║   🐱  NyatBot 一键安装                    ║
  ╚══════════════════════════════════════════╝
EOF
printf "${Z}"

[ "$(id -u)" = 0 ] || die "请用 root 运行：curl -fsSL .../install.sh | sudo bash"
command -v systemctl >/dev/null || die "没有 systemd（容器/OpenVZ？）请改用 Docker 部署"

# ── 装 git ───────────────────────────────────────────────────────────────────
if ! command -v git >/dev/null 2>&1; then
  say "安装 git"
  if   command -v apt-get >/dev/null; then apt-get update -y && apt-get install -y git
  elif command -v dnf >/dev/null;     then dnf install -y git
  elif command -v yum >/dev/null;     then yum install -y git
  elif command -v zypper >/dev/null;  then zypper --non-interactive install git
  elif command -v pacman >/dev/null;  then pacman -Sy --noconfirm git
  elif command -v apk >/dev/null;     then apk add --no-cache git
  else die "没找到包管理器，请先手动装 git 再重试"; fi
  ok "git 已安装"
fi

# ── 拉源码（已存在则更新）────────────────────────────────────────────────────
if [ -d "$DIR/.git" ]; then
  say "已存在 $DIR，更新源码"
  git -C "$DIR" fetch --depth 1 origin "$BRANCH" && git -C "$DIR" reset --hard "origin/$BRANCH" || die "更新失败：检查网络/代理，或删掉 $DIR 重装"
  ok "已更新到最新"
else
  say "拉取源码 → $DIR"
  if ! git clone --depth 1 -b "$BRANCH" "$REPO" "$DIR"; then
    die "clone 失败（GitHub 被墙？）。试：export HTTPS_PROXY=http://127.0.0.1:7890 重跑，或换镜像：NYATBOT_REPO=https://ghproxy.com/$REPO  /  https://gitee.com/<your-mirror>.git"
  fi
  ok "源码就绪"
fi

# ── 交给安装向导 ─────────────────────────────────────────────────────────────
say "进入安装向导（接下来会问你 bot token、AI 接口、主人 UID 等）"
ok "可选：向导可装 Rust 编 NyatDB native（公开仓库 https://github.com/ZYHUO/nyatdb ；默认关）"
cd "$DIR"
chmod +x scripts/install.sh 2>/dev/null || true
exec bash scripts/install.sh "$@"
