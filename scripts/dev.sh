#!/usr/bin/env bash
#
# One command to develop Taut over Tailscale.
#
#   pnpm dev:ts                 server + web + the Electron shell, all on
#                               https://<machine>.<tailnet>.ts.net:8443
#   pnpm dev:ts --no-desktop    skip Electron (browser only)
#   pnpm dev:ts --local         no Tailscale; plain http://localhost:5173
#   pnpm dev:ts --calls         also start the dev SFU, so huddles work
#
# Why a proxy instead of just `vite --host`: the web client is a PWA with web
# push, and service workers need a secure context. `tailscale serve` terminates
# TLS with a real cert for the tailnet, so the phone gets HTTPS for free and
# everything (app, /api, /ws) stays on one origin.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

WEB_PORT=5173
# 443 is often already taken by another `tailscale serve` mapping; 8443 is the
# next port Tailscale will terminate TLS on.
TS_PORT="${TAUT_DEV_TS_PORT:-8443}"

USE_TAILSCALE=1
WITH_DESKTOP=1
WITH_CALLS=0
# Second TLS front door, for the SFU: the page is served over https, so its
# signalling socket has to be wss or the browser blocks it as mixed content.
LK_TS_PORT="${TAUT_DEV_LIVEKIT_TS_PORT:-8444}"

for arg in "$@"; do
  case "$arg" in
    --desktop) WITH_DESKTOP=1 ;;
    --no-desktop) WITH_DESKTOP=0 ;;
    --local) USE_TAILSCALE=0 ;;
    --calls) WITH_CALLS=1 ;;
    -h | --help)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "dev.sh: unknown argument '$arg' (try --no-desktop, --local, --calls, --help)" >&2
      exit 2
      ;;
  esac
done

log() { printf '\033[36m▸\033[0m %s\n' "$*"; }
die() {
  printf '\033[31m✗\033[0m %s\n' "$*" >&2
  exit 1
}

# ── Tailscale ─────────────────────────────────────────────────────────────────
if [[ $USE_TAILSCALE == 1 ]]; then
  TAILSCALE="$(command -v tailscale || true)"
  [[ -z $TAILSCALE && -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]] &&
    TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  [[ -n $TAILSCALE ]] || die "tailscale CLI not found. Install it, or run with --local."

  state="$("$TAILSCALE" status --json | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["BackendState"])')"
  [[ $state == Running ]] || die "Tailscale is $state, not Running. Run 'tailscale up', or use --local."

  # MagicDNS name of this machine, minus the trailing dot.
  TS_HOST="$("$TAILSCALE" status --json |
    /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
  [[ -n $TS_HOST ]] || die "Could not read this machine's MagicDNS name."

  PUBLIC_URL="https://${TS_HOST}:${TS_PORT}"

  log "Serving https://${TS_HOST}:${TS_PORT} → http://127.0.0.1:${WEB_PORT}"
  "$TAILSCALE" serve --bg --https="$TS_PORT" "http://127.0.0.1:${WEB_PORT}" >/dev/null

  # Vite reads these: bind 0.0.0.0, allow the ts.net Host header, and point the
  # HMR client at the TLS front door instead of the bare dev port.
  export TAUT_DEV_TS_HOST="$TS_HOST"
  export TAUT_DEV_TS_PORT="$TS_PORT"
  # Agent machines and the taut MCP server call back on this.
  export TAUT_PUBLIC_URL="${TAUT_PUBLIC_URL:-$PUBLIC_URL}"
  # The Electron shell loads the same origin the phone does.
  export TAUT_DEV_INSTANCE_URL="${TAUT_DEV_INSTANCE_URL:-$PUBLIC_URL}"

  if [[ $WITH_CALLS == 1 ]]; then
    log "Serving wss://${TS_HOST}:${LK_TS_PORT} → http://127.0.0.1:7880 (SFU)"
    "$TAILSCALE" serve --bg --https="$LK_TS_PORT" http://127.0.0.1:7880 >/dev/null
    export TAUT_DEV_LIVEKIT_URL="wss://${TS_HOST}:${LK_TS_PORT}"
    # Media goes straight to this machine over the tailnet, not through the proxy,
    # so LiveKit has to advertise the tailnet address rather than 127.0.0.1.
    export TAUT_DEV_LIVEKIT_NODE_IP="$("$TAILSCALE" ip -4 | head -1)"
  fi
else
  PUBLIC_URL="http://localhost:${WEB_PORT}"
fi

# Turbo goes down with us, and `serve off` clears only OUR port — any other
# mapping on this machine (there is usually one on :443) is left alone.
cleanup() {
  trap - EXIT INT TERM
  [[ -n ${TURBO_PID:-} ]] && kill -TERM "$TURBO_PID" 2>/dev/null
  if [[ $USE_TAILSCALE == 1 ]]; then
    log "Removing the Tailscale mapping on :${TS_PORT}"
    "$TAILSCALE" serve --https="$TS_PORT" off >/dev/null 2>&1 || true
    [[ $WITH_CALLS == 1 ]] &&
      "$TAILSCALE" serve --https="$LK_TS_PORT" off >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

# ── Preflight ─────────────────────────────────────────────────────────────────
# A previous run that was killed hard leaves listeners behind. The web and API
# ports recover on their own; the Electron renderer is strictPort, so 5273 has
# to be clear before turbo starts or `@taut/desktop#dev` dies immediately.
preflight_ports=("${PORT:-3000}" "$WEB_PORT")
[[ $WITH_DESKTOP == 1 ]] && preflight_ports+=(5273)
# Not the SFU's own ports: docker holds those, and free-ports.sh is scoped to
# processes in this checkout. dev-livekit.sh replaces its own container instead.
bash scripts/free-ports.sh "${preflight_ports[@]}" ||
  die "Could not free the dev ports. See the listing above."

# ── Go ────────────────────────────────────────────────────────────────────────
filters=(--filter=@taut/server --filter=@taut/web)
[[ $WITH_DESKTOP == 1 ]] && filters+=(--filter=@taut/desktop)

echo
printf '  \033[1mTaut dev\033[0m\n'
printf '  web      %s\n' "$PUBLIC_URL"
printf '  api/ws   %s/api  ·  %s/ws\n' "$PUBLIC_URL" "${PUBLIC_URL/https:/wss:}"
[[ $WITH_DESKTOP == 1 ]] && printf '  desktop  Electron shell → %s\n' "$PUBLIC_URL"
[[ $USE_TAILSCALE == 1 ]] && printf '  phone    open %s on any device in the tailnet\n' "$PUBLIC_URL"
[[ $WITH_CALLS == 1 ]] && printf '  calls    SFU on %s\n' "${TAUT_DEV_LIVEKIT_URL:-ws://localhost:7880}"
echo

# Deliberately not `exec`: this shell has to outlive turbo to run `cleanup`.
if [[ $WITH_CALLS == 1 ]]; then
  bash scripts/dev-livekit.sh run pnpm exec turbo run dev "${filters[@]}" &
else
  pnpm exec turbo run dev "${filters[@]}" &
fi
TURBO_PID=$!
wait "$TURBO_PID"
