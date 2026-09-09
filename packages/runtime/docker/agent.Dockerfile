# taut/agent — the box every Taut agent lives in (docs/agent-model.md §7).
#
# Lineage: Sandcastle's scaffolded image (MIT, see ../NOTICE): Debian + Node 22 +
# git, non-root `agent` uid 1000. The container runs `sleep infinity`; tasks are
# `docker exec` calls with per-task env (secrets never land in the image or in
# `docker run`). `/home/agent` is bind-mounted from the host, so nothing written
# there in this image survives — keep state out of it.
#
# Build: pnpm --filter @taut/runtime build:image
#   (builds @taut/taut-mcp, copies its dist/mcp.js into ./docker, then runs)
#   docker build -f docker/agent.Dockerfile -t taut/agent:latest docker
#
# Contents besides the runtimes:
# - /opt/taut/mcp.js       the bundled `taut` MCP server (`node /opt/taut/mcp.js`,
#                          the default in @taut/taut-mcp inject.ts) — closes CHANGELOG gap 4
# - /usr/local/bin/taut    the bundled `taut` CLI. Same tool table as the MCP server, and the
#                          git credential helper `!taut git-credential` that lets git clone a
#                          private company repository with a token that never lands on disk
#                          (docs/build-plan-repositories.md D4)
# - playwright-mcp         @playwright/mcp 0.0.80 as a global bin (docs/build-plan-browser-vaults.md D1)
# - /opt/pw-browsers       Chromium for it (PLAYWRIGHT_BROWSERS_PATH), outside the bind-mounted
#                          home so it survives; world-readable for uid 1000 (D7). Chromium is
#                          launched with --no-sandbox by the runtime (the container is the sandbox)
#                          and writes only under --user-data-dir (<home>/.taut/browser/profile) and
#                          /tmp (tmpfs), so it works on the read-only rootfs; Playwright adds
#                          --disable-dev-shm-usage itself.
#
# cursor-agent is intentionally absent: its installer is a curl|bash script that
# unpacks into $HOME, which is hidden by the bind mount. Add it to the agent home
# instead if you need it (docs/research/agent-sandboxes.md §5).

FROM node:22-bookworm-slim

# Pinned, not `latest`. Anthropic's headless docs say `--bare` "will become the
# default for `-p` in a future release", and in bare mode Claude Code "never reads
# OAuth credentials or the system keychain" — auth is strictly ANTHROPIC_API_KEY.
# On the release that flips that default, every `claude.oauth` / `claude.login`
# seat starts failing with `authentication_failed` and only `anthropic.api_key`
# survives; there is no `--no-bare` to opt out (checked against 2.1.266). Bump
# deliberately, after re-reading https://code.claude.com/docs/en/headless.
ARG CLAUDE_CODE_VERSION=2.1.266
ARG CODEX_VERSION=latest
ARG OPENCODE_VERSION=latest
# Pinned: docs/build-plan-browser-vaults.md D1. Its own `playwright` dependency
# (1.63.0-alpha-2026-08-31 for 0.0.80) is the one that downloads Chromium, so the
# browser build always matches the MCP server.
ARG PLAYWRIGHT_MCP_VERSION=0.0.80

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git jq openssh-client procps ripgrep unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
    "opencode-ai@${OPENCODE_VERSION}" \
    "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
  && npm cache clean --force

# Chromium for Playwright MCP, installed by the exact `playwright` that @playwright/mcp
# depends on (it lives under the global package's own node_modules). `--with-deps`
# apt-installs Chromium's shared libraries. Must run as root, before `USER agent`.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN set -eux; \
  PW_CLI="$(npm root -g)/@playwright/mcp/node_modules/playwright/cli.js"; \
  test -f "$PW_CLI"; \
  node "$PW_CLI" install --with-deps chromium; \
  rm -rf /var/lib/apt/lists/*; \
  chmod -R a+rX /opt/pw-browsers; \
  playwright-mcp --version

# The bundled taut MCP server and CLI (copied into the build context by `build:image`).
COPY mcp.js /opt/taut/mcp.js
COPY cli.js /opt/taut/cli.js
RUN chmod 0644 /opt/taut/mcp.js /opt/taut/cli.js \
 && node --check /opt/taut/mcp.js \
 && node --check /opt/taut/cli.js \
 && printf '#!/bin/sh\nexec node /opt/taut/cli.js "$@"\n' > /usr/local/bin/taut \
 && chmod 0755 /usr/local/bin/taut

# The node image ships a `node` user at uid/gid 1000; rename it so the in-container
# identity matches the MachineSpec (`User: "1000:1000"`) and the bind-mounted home.
RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node

ENV HOME=/home/agent \
    LANG=C.UTF-8 \
    TERM=dumb \
    CLAUDE_CONFIG_DIR=/home/agent/.taut/claude \
    CODEX_HOME=/home/agent/.taut/codex \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

USER agent
WORKDIR /home/agent

CMD ["sleep", "infinity"]
