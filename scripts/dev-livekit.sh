#!/usr/bin/env bash
#
# The development SFU: one LiveKit container, no Redis, no TURN.
#
#   bash scripts/dev-livekit.sh start     # start it (idempotent)
#   bash scripts/dev-livekit.sh stop
#   bash scripts/dev-livekit.sh status
#   bash scripts/dev-livekit.sh env       # export lines for eval
#   bash scripts/dev-livekit.sh run CMD…  # start it, run CMD with the vars set, stop it after
#
# Production runs three containers behind `--profile calls` (docs/deploy.md). None of
# that is needed to try a huddle on this machine: one node needs no Redis, and a browser
# talking to a server on the same host needs no TURN. What it does need is the webhook
# path, because who is in a room is decided by LiveKit and not by the browser
# (docs/build-plan-calls.md D2) — so the container is given a route back to the dev
# server on the host, and that is the part that silently breaks the participant list
# when it is missing.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CONTAINER=taut-dev-livekit
# Pinned to the version production runs. Override only to try another build, or to
# use one already on this machine when the pull is slow.
IMAGE="${TAUT_DEV_LIVEKIT_IMAGE:-livekit/livekit-server:v1.13.6}"

# Fixed on purpose: a dev token minted before a restart still works after it, and no
# generated secret ends up pasted into a shell history. Never reachable from outside
# this machine unless you publish the ports yourself.
API_KEY=devkey
API_SECRET=devsecretdevsecretdevsecretdevsecret1234

SERVER_PORT="${PORT:-3000}"
# Where the browser reaches the SFU. Overridden for a Tailscale run, where the page is
# https and a ws:// socket would be blocked as mixed content (scripts/dev.sh --calls).
PUBLIC_WS="${TAUT_DEV_LIVEKIT_URL:-ws://localhost:7880}"
# What LiveKit advertises as its media address. 127.0.0.1 is right for a browser on this
# machine; a phone on the tailnet needs this machine's tailnet IPv4 instead.
NODE_IP="${TAUT_DEV_LIVEKIT_NODE_IP:-127.0.0.1}"

log() { printf '\033[36m▸\033[0m %s\n' "$*"; }
die() {
  printf '\033[31m✗\033[0m %s\n' "$*" >&2
  exit 1
}

running() { [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" == true ]]; }

config() {
  cat <<YAML
port: 7880
rtc:
  tcp_port: 7881
  # Single-port UDP mux, same as production (docs/build-plan-calls.md D9).
  udp_port: 7882
  # STUN discovery would hand out this machine's public address, which no client here
  # can route to. In dev we say exactly where we are.
  use_external_ip: false
  node_ip: ${NODE_IP}
keys:
  ${API_KEY}: ${API_SECRET}
webhook:
  api_key: ${API_KEY}
  urls:
    - http://host.docker.internal:${SERVER_PORT}/api/hooks/livekit
logging:
  level: info
YAML
}

start() {
  command -v docker >/dev/null || die "docker not found — calls need it in dev. Start Docker Desktop, or run 'pnpm dev' without calls."
  docker info >/dev/null 2>&1 || die "docker is installed but not running. Start Docker Desktop and try again."

  # Reuse a running SFU only when it was started from the same config. Otherwise a
  # second `dev:calls` with a different address — localhost here, the tailnet there —
  # silently keeps the old container and every remote client fails to connect. The
  # config is multi-line, so its hash rides along as a label rather than being
  # compared out of the container's environment.
  local want
  want="$(config | shasum -a 256 | cut -d' ' -f1)"
  if running; then
    if [[ "$(docker inspect -f '{{index .Config.Labels "taut.config"}}' "$CONTAINER" 2>/dev/null)" == "$want" ]]; then
      log "SFU already up ($CONTAINER)"
      return 0
    fi
    log "Config changed — replacing the running SFU"
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

  log "Starting the dev SFU on 7880/7881/7882 → webhooks to :${SERVER_PORT}"
  docker run -d --rm \
    --name "$CONTAINER" \
    -p 7880:7880 -p 7881:7881 -p 7882:7882/udp \
    --add-host host.docker.internal:host-gateway \
    --label "taut.config=${want}" \
    -e LIVEKIT_CONFIG="$(config)" \
    "$IMAGE" >/dev/null

  # A bad config makes livekit-server exit immediately, and `docker run -d` still
  # succeeds — so prove it is listening rather than trusting the start.
  for _ in $(seq 1 25); do
    if curl -sf -o /dev/null "http://127.0.0.1:7880" 2>/dev/null; then
      log "SFU ready at ${PUBLIC_WS}"
      return 0
    fi
    running || {
      docker logs "$CONTAINER" 2>&1 | tail -20 >&2 || true
      die "the SFU exited on startup — its last lines are above"
    }
    sleep 0.2
  done
  die "the SFU did not answer on 7880 within 5s. 'docker logs $CONTAINER' has the reason."
}

stop() {
  running || {
    log "SFU not running"
    return 0
  }
  log "Stopping the dev SFU"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}

env_lines() {
  echo "export TAUT_LIVEKIT_URL='${PUBLIC_WS}'"
  echo "export TAUT_LIVEKIT_INTERNAL_URL='http://127.0.0.1:7880'"
  echo "export TAUT_LIVEKIT_API_KEY='${API_KEY}'"
  echo "export TAUT_LIVEKIT_API_SECRET='${API_SECRET}'"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status)
    if running; then
      log "up — ${PUBLIC_WS} (key ${API_KEY})"
    else
      log "down"
      exit 1
    fi
    ;;
  env) env_lines ;;
  run)
    shift
    [[ $# -gt 0 ]] || die "run needs a command"
    # Only tear down what we brought up: a container you started by hand survives.
    WE_STARTED_IT=0
    running || WE_STARTED_IT=1
    start
    cleanup() {
      trap - EXIT INT TERM
      [[ $WE_STARTED_IT == 1 ]] && stop
    }
    trap cleanup EXIT INT TERM
    eval "$(env_lines)"
    "$@"
    ;;
  -h | --help | '')
    sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *) die "unknown command '${1}' (start, stop, status, env, run)" ;;
esac
