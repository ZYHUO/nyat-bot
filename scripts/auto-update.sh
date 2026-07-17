#!/bin/bash
# ────────────────────────────────────────
# xxb-ts auto-update:自动对齐 GitHub(origin/main)
# ────────────────────────────────────────
# 由 systemd timer(xxb-autoupdate.timer,每 5min)外部驱动 —— 不能让 bot 进程
# 自己更新自己。只做最保守的动作:
#   - 本地 == 远端 → 无事发生(静默)
#   - 工作区有**已跟踪文件**改动(开发中)→ 跳过,绝不动工作区
#   - 本地领先/分叉(本机就是开发机,常见)→ 跳过,只在**严格落后**时更新
#   - 严格落后 → git pull --ff-only → (lockfile 变了则 npm ci)→ build →
#     build 成功才 restart;失败**自动回滚**到原 commit 并重建,不重启(保住线上)
# 日志:logs/auto-update.log(带时间戳,只在有动作/出错时写)

set -u
REPO=/root/xxb-ts
LOG="$REPO/logs/auto-update.log"
LOCK=/tmp/xxb-autoupdate.lock

exec 9>"$LOCK"
flock -n 9 || exit 0   # 已有实例在跑

cd "$REPO" || exit 1
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

git fetch -q origin main 2>>"$LOG" || { log "fetch failed"; exit 1; }

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0   # 已同步,静默退出

# 工作区已跟踪文件有改动(开发中)→ 不碰
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "skip: dirty working tree (local dev in progress), behind=$REMOTE"
  exit 0
fi

# 只在严格落后(LOCAL 是 REMOTE 的祖先)时 ff;领先/分叉都跳过
BASE=$(git merge-base "$LOCAL" "$REMOTE")
if [ "$BASE" != "$LOCAL" ]; then
  log "skip: local ahead/diverged (local=$LOCAL remote=$REMOTE)"
  exit 0
fi

log "updating: $LOCAL -> $REMOTE"
git pull --ff-only -q origin main 2>>"$LOG" || { log "pull failed"; exit 1; }

# lockfile 变了才重装依赖
if ! git diff --quiet "$LOCAL" HEAD -- package-lock.json; then
  log "package-lock changed, npm ci"
  npm ci --no-audit --no-fund >>"$LOG" 2>&1 || {
    log "npm ci FAILED, rolling back"
    git reset --hard -q "$LOCAL"; npm ci --no-audit --no-fund >>"$LOG" 2>&1
    exit 1
  }
fi

if npm run build >>"$LOG" 2>&1; then
  systemctl restart xxb-ts
  log "updated to $(git rev-parse --short HEAD) + rebuilt + restarted OK"
else
  log "build FAILED, rolling back to $LOCAL (service NOT restarted, old build keeps running)"
  git reset --hard -q "$LOCAL"
  npm run build >>"$LOG" 2>&1 || log "rollback rebuild ALSO failed — dist may be stale, manual attention needed"
  exit 1
fi
