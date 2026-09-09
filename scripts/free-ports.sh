#!/usr/bin/env bash
#
# Preflight for every dev entry point: make the ports Taut needs actually free.
#
#   bash scripts/free-ports.sh              # 3000 (server) 5173 (web) 5273 (shell)
#   bash scripts/free-ports.sh 3000 5173    # only these
#
# A crashed or backgrounded run leaves three kinds of debris behind: a listener
# still holding a port, an orphaned Electron process whose parent vite server is
# gone, and a `tailscale serve` mapping. Vite picks another port when it can,
# but the Electron renderer is strictPort, so a leftover on 5273 is fatal.
# Everything here is scoped to this checkout and to ports Taut owns.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO="$PWD"

PORTS=("$@")
[[ ${#PORTS[@]} -eq 0 ]] && PORTS=(3000 5173 5273)

log() { printf '\033[36m▸\033[0m %s\n' "$*"; }

listeners() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u; }

# TERM first, then KILL, polling until the socket is actually released. Without
# the poll we race the next `vite` into the same "already in use" error.
free_port() {
  local port=$1 sig pids i
  for sig in TERM KILL; do
    pids=$(listeners "$port")
    [[ -z $pids ]] && return 0
    log "port $port held by pid(s) $(echo "$pids" | tr '\n' ' ')— sending SIG$sig"
    # shellcheck disable=SC2086
    kill -"$sig" $pids 2>/dev/null
    for ((i = 0; i < 30; i++)); do
      [[ -z $(listeners "$port") ]] && return 0
      sleep 0.1
    done
  done
  [[ -z $(listeners "$port") ]] && return 0
  printf '\033[31m✗\033[0m port %s is still in use and would not die. Check: lsof -nP -iTCP:%s -sTCP:LISTEN\n' \
    "$port" "$port" >&2
  return 1
}

# Electron from THIS checkout only: its argv carries the app path.
kill_stale_electron() {
  local pids
  pids=$(pgrep -f "${REPO}/apps/desktop" 2>/dev/null | grep -vx "$$" || true)
  [[ -z $pids ]] && return 0
  log "stopping $(echo "$pids" | wc -w | tr -d ' ') stale desktop process(es)"
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null
  sleep 0.4
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null
  return 0
}

kill_stale_electron
status=0
for port in "${PORTS[@]}"; do
  free_port "$port" || status=1
done
exit "$status"
