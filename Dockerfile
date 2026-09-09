# Taut — single image, single volume (docs/agent-model.md §0).
#
#   docker build -t taut:dev .
#   docker run -p 3000:3000 -v taut-data:/data -e TAUT_MASTER_KEY=$(openssl rand -base64 32) taut:dev
#
# The image contains the API/WS server (Effect + SQLite) and the built web client.
# Agent runtimes (claude, codex, opencode) live in a *second* image, taut/agent,
# built from packages/runtime/docker/agent.Dockerfile — never in here (§7).

# ---------------------------------------------------------------------------
# base — pnpm via corepack, shared by every build stage
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------
# deps — warm the pnpm store from the lockfile alone, so editing source code
#        never re-downloads a tarball
# ---------------------------------------------------------------------------
FROM base AS deps
# package.json comes along only for its `packageManager` field, so corepack
# resolves the exact pnpm version without a prompt.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json ./
RUN pnpm fetch

# ---------------------------------------------------------------------------
# build — install offline from the warm store, then build server + web
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .
# apps/desktop (Electron) is excluded by the filter: nothing in the server image
# needs it and its postinstall downloads a ~150 MB binary.
RUN pnpm install --frozen-lockfile --offline \
      --filter '@taut/server...' \
      --filter '@taut/web...'
RUN pnpm turbo build --filter=@taut/server --filter=@taut/web
# Fail loudly here rather than shipping an image that 404s at /.
RUN test -f apps/server/dist/main.js && test -f apps/web/dist/index.html

# Prod-only, workspace-resolved copy of @taut/server (source, dist, package.json
# and a flat node_modules with the better-sqlite3 native binding) at /out.
RUN pnpm deploy --filter=@taut/server --prod --legacy /out \
 && test -f /out/dist/main.js

# ---------------------------------------------------------------------------
# dockercli — just the `docker` client binary from the official static tarball
#             (~40 MB; `docker.io` from Debian would drag in the whole engine)
# ---------------------------------------------------------------------------
FROM base AS dockercli
ARG DOCKER_CLI_VERSION=28.5.2
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz; \
    tar -xzf /tmp/docker.tgz -C /tmp docker/docker; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
    rm -rf /tmp/docker /tmp/docker.tgz; \
    docker --version

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# The stock `node` user already owns uid 1000; replace it with `taut` so the
# agent containers (also uid 1000, §7) and the /data volume line up.
RUN set -eux; \
    userdel -r node >/dev/null 2>&1 || true; \
    groupadd -g 1000 taut; \
    useradd -u 1000 -g 1000 -m -s /bin/bash taut

# `docker` CLI: the MachineProvider drives the host socket to run one
# taut/agent container per agent (docs/agent-model.md §7). Harmless when the
# instance is configured with the `local` provider and no socket is mounted.
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY --from=build --chown=taut:taut /out ./
# Belt and braces: guarantee dist/ regardless of how `pnpm deploy` filters files.
COPY --from=build --chown=taut:taut /repo/apps/server/dist ./dist
# Built SPA, served at / with fallback by src/http/static.ts.
COPY --from=build --chown=taut:taut /repo/apps/web/dist ./web

RUN install -d -o taut -g taut /data

ENV NODE_ENV=production \
    PORT=3000 \
    TAUT_DATA_DIR=/data \
    TAUT_WEB_DIST=/app/web

VOLUME ["/data"]
EXPOSE 3000
USER taut

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "/app/dist/main.js"]
