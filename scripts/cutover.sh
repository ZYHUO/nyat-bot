#!/bin/bash
# xxb-ts cutover script
# Usage: ./scripts/cutover.sh [--rollback]

set -euo pipefail

# Load env
source .env

# Validate required cutover vars before any destructive operations
: "${BOT_TOKEN:?BOT_TOKEN must be set in .env}"
: "${TS_WEBHOOK_URL:?TS_WEBHOOK_URL must be set in .env}"
: "${PHP_WEBHOOK_URL:?PHP_WEBHOOK_URL must be set in .env}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ "${1:-}" = "--rollback" ]; then
    echo -e "${YELLOW}Rolling back to PHP...${NC}"
    # 1. Set PHP webhook
    curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${PHP_WEBHOOK_URL}" | jq .
    # 2. Stop TS
    if command -v systemctl &>/dev/null && systemctl list-unit-files | grep -q '^xxb-ts.service'; then
        systemctl stop xxb-ts 2>/dev/null || true
    fi
    if command -v pm2 &>/dev/null; then
        pm2 stop xxb-ts 2>/dev/null || true
    fi
    if command -v docker &>/dev/null; then
        docker compose stop xxb 2>/dev/null || true
    fi
    echo -e "${GREEN}Rolled back to PHP${NC}"
    exit 0
fi

echo -e "${YELLOW}Starting xxb-ts cutover...${NC}"

# 1. Stop PHP webhook first to prevent data race during migration
echo "Step 1: Stopping PHP webhook..."
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=" | jq .
echo "Waiting 5s for in-flight requests to drain..."
sleep 5

# 2. Run migration scripts
echo "Step 2: Running data migrations..."
npx tsx scripts/migrate-context.ts
npx tsx scripts/migrate-sticker.ts
npx tsx scripts/migrate-allowlist.ts

# 3. Start TS
echo "Step 3: Starting TS bot..."
if command -v systemctl &>/dev/null && systemctl list-unit-files | grep -q '^xxb-ts.service'; then
    systemctl restart xxb-ts
elif [ -f docker-compose.yml ] && command -v docker &>/dev/null; then
    docker compose up -d
else
    pm2 start ecosystem.config.cjs --env production
fi

# 4. Wait for health check
echo "Step 4: Waiting for health check..."
for i in $(seq 1 30); do
    if curl -sf "http://localhost:${PORT:-3000}/health" > /dev/null 2>&1; then
        echo -e "${GREEN}Health check passed!${NC}"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo -e "${RED}Health check failed after 30s — rolling back!${NC}"
        "$0" --rollback
        exit 1
    fi
    sleep 1
done

# 5. Set TS webhook
echo "Step 5: Setting TS webhook..."
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${TS_WEBHOOK_URL}" | jq .

echo -e "${GREEN}Cutover complete! Monitor for 15 minutes.${NC}"
echo -e "To rollback: $0 --rollback"
