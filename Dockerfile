# --- Stage 1: Build ---
FROM node:22-slim AS builder
WORKDIR /app

# Native module build deps (better-sqlite3).
# NyatDB: image ships the TS engine via @nyat/nyatdb (default OFF via env).
# Rust napi addon is not built here — use host install (deploy.sh / install.sh) for NYATDB_NATIVE.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/ packages/
COPY native/nyatdb/package.json native/nyatdb/package-lock.json ./native/nyatdb/
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
COPY prompts/ prompts/
COPY migrations/ migrations/
RUN npm run build

# --- Stage 2: Production ---
FROM node:22-slim AS runner
WORKDIR /app

# Native module build deps (better-sqlite3) + curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/ packages/
COPY native/nyatdb/package.json native/nyatdb/package-lock.json ./native/nyatdb/
RUN npm ci --omit=dev \
    && apt-get purge -y python3 make g++ \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY prompts/ prompts/
COPY migrations/ migrations/

# data/ holds sqlite, qdrant, and optional NyatDB (./data/nyatdb) via compose volume
RUN mkdir -p /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
