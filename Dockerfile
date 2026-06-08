# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:22-slim
ARG PNPM_VERSION=10.33.0

# -----------------------------
# Builder stage
# -----------------------------
FROM ${NODE_IMAGE} AS builder

WORKDIR /workspace

# Native addons (better-sqlite3 etc.) need to be compiled locally when no prebuilt binary is available
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# -----------------------------
# Copy concord workspace
# -----------------------------
COPY concord/pnpm-workspace.yaml concord/pnpm-lock.yaml concord/package.json ./concord/
COPY concord/tsconfig.base.json ./concord/
COPY concord/patch-packages.mjs ./concord/
COPY concord/packages ./concord/packages
COPY concord/apps ./concord/apps

# -----------------------------
# Copy external workspace packages
# -----------------------------
COPY vibly-coordinator ./vibly-coordinator
COPY vibly-coordinator-http-contract ./vibly-coordinator-http-contract
COPY vibly-client ./vibly-client
COPY vibly-console ./vibly-console

# -----------------------------
# Patch workspace packages BEFORE install
# Ensure all concord packages' exports point to dist/ (not src/*.ts)
# so pnpm records the correct metadata during install -> deploy
# -----------------------------
RUN node /workspace/concord/patch-packages.mjs

# -----------------------------
# Install and build
# -----------------------------
WORKDIR /workspace/concord

RUN pnpm install --frozen-lockfile

# Build all concord packages that vibly-coordinator depends on (dependencies built first)
RUN pnpm -r --filter "vibly-coordinator..." run --if-present build

# Verify concord sdk dist exists after build
RUN test -f /workspace/concord/packages/sdk/dist/index.js && echo "[ok] @concord/sdk dist/index.js built" || { echo "[FAIL] @concord/sdk dist/index.js missing"; exit 1; }

# Generate a standalone production directory to prevent pnpm workspace symlinks from breaking at runtime.
# pnpm deploy copies dist/ artifacts based on the "files": ["dist"] config in each workspace package's package.json.
RUN pnpm --filter vibly-coordinator deploy --prod --legacy /app

# pnpm deploy does not automatically include the top-level package's own build output, so copy it explicitly.
RUN rm -rf /app/dist && cp -r /workspace/vibly-coordinator/dist /app/dist

# Drizzle migration files (.json/.sql) are not compiled to dist/ by tsc, so copy them separately.
RUN cp -r /workspace/vibly-coordinator/src/db/postgres/migrations /app/dist/db/postgres/migrations

# -----------------------------
# Post-build validation
# -----------------------------
RUN echo "=== Post-build validation ===" && \
    test -f /app/dist/main.js && echo "[ok] /app/dist/main.js exists" || { echo "[FAIL] /app/dist/main.js missing"; exit 1; } && \
    test -f /app/dist/network-manifest.json && echo "[ok] /app/dist/network-manifest.json exists" || { echo "[FAIL] /app/dist/network-manifest.json missing"; exit 1; } && \
    test -f /app/node_modules/@concord/sdk/package.json && echo "[ok] @concord/sdk installed" || { echo "[FAIL] @concord/sdk not found"; exit 1; } && \
    test -f /app/node_modules/@concord/sdk/dist/index.js && echo "[ok] @concord/sdk/dist/index.js exists" || { echo "[FAIL] @concord/sdk/dist/index.js missing"; exit 1; } && \
    node -e "const p = JSON.parse(require('fs').readFileSync('/app/node_modules/@concord/sdk/package.json','utf8')); \
      const exp = p.exports && p.exports['.']; \
      if (!exp || (typeof exp === 'string' && exp.includes('src/index.ts')) || (typeof exp === 'object' && exp.default && exp.default.includes('src/index.ts'))) { \
        console.error('[FAIL] @concord/sdk exports still points to src/index.ts:', JSON.stringify(exp)); process.exit(1); \
      } else { \
        console.log('[ok] @concord/sdk exports:', JSON.stringify(exp)); \
      }"

# -----------------------------
# Runtime stage
# -----------------------------
FROM ${NODE_IMAGE} AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV NETWORK_MANIFEST_FILE=dist/network-manifest.json

COPY --from=builder /app ./

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/health', (r) => { if (r.statusCode !== 200) process.exit(1); }).on('error', () => process.exit(1))"

CMD ["node", "--env-file-if-exists=.env", "dist/main.js"]