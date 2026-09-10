# One Railway service for a trusted company. Agents share this service's filesystem
# and process identity; use the VPS installer when separate agent containers are needed.
# Build from the repository root: docker build -f deploy/railway/Dockerfile -t taut/railway .
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter '@taut/server...' --filter '@taut/web...' --filter '@taut/taut-mcp...' \
 && pnpm turbo build --filter=@taut/server --filter=@taut/web --filter=@taut/taut-mcp \
 && pnpm deploy --filter=@taut/server --prod --legacy /out \
 && test -f /out/dist/main.js \
 && test -f apps/web/dist/index.html \
 && test -f packages/taut-mcp/dist/mcp.js

FROM node:22-bookworm-slim AS runtime
ARG CLAUDE_CODE_VERSION=2.1.266
ARG CODEX_VERSION=0.154.0
ARG OPENCODE_VERSION=1.18.30
ARG PLAYWRIGHT_MCP_VERSION=0.0.80
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ca-certificates curl git jq openssh-client procps ripgrep unzip tini util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
    "opencode-ai@${OPENCODE_VERSION}" \
    "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && npm cache clean --force \
 && node /usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright/cli.js install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /opt/pw-browsers
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /repo/apps/web/dist ./web
COPY --from=build /repo/packages/taut-mcp/dist/mcp.js /opt/taut/mcp.js
COPY --from=build /repo/packages/taut-mcp/dist/cli.js /opt/taut/cli.js
COPY deploy/railway/entrypoint.sh /usr/local/bin/taut-start
RUN mkdir -p /app/node_modules/@playwright \
 && ln -s /usr/local/lib/node_modules/@playwright/mcp /app/node_modules/@playwright/mcp \
 && printf '#!/bin/sh\nexec node /opt/taut/cli.js "$@"\n' > /usr/local/bin/taut \
 && chmod 0755 /usr/local/bin/taut /usr/local/bin/taut-start \
 && node --check /opt/taut/mcp.js \
 && node --check /opt/taut/cli.js
ENV NODE_ENV=production PORT=3000 TAUT_DATA_DIR=/data TAUT_WEB_DIST=/app/web \
    TAUT_MACHINE_PROVIDER=local TAUT_MCP_COMMAND="node /opt/taut/mcp.js" \
    TAUT_BROWSER_NO_SANDBOX=true TAUT_DEV_HOST_LOGIN=false \
    TAUT_MAX_CONCURRENT_TASKS=2 HOME=/home/node USER=node LANG=C.UTF-8 TERM=dumb \
    DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# Persistent storage is attached by the Railway template at /data.
EXPOSE 3000
# Railway volumes arrive owned by root. The entrypoint prepares only the volume
# root, then drops to uid 1000 before running Taut or any agent process.
USER root
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/taut-start"]
CMD ["node", "/app/dist/main.js"]
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
