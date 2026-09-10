#!/bin/sh
set -eu

data_dir=${TAUT_DATA_DIR:-/data}
case "$data_dir" in
  /) echo 'TAUT_DATA_DIR must not be the filesystem root' >&2; exit 1 ;;
  /*) ;;
  *) echo 'TAUT_DATA_DIR must be an absolute path' >&2; exit 1 ;;
esac

export TAUT_DATA_DIR="$data_dir"
export TAUT_AGENT_API_URL="${TAUT_AGENT_API_URL:-http://127.0.0.1:${PORT:-3000}}"
if [ -z "${TAUT_PUBLIC_URL:-}" ] && [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  export TAUT_PUBLIC_URL="https://$RAILWAY_PUBLIC_DOMAIN"
fi

if [ "$(id -u)" = 0 ]; then
  mkdir -p "$data_dir"
  chown 1000:1000 "$data_dir"
  chmod 0700 "$data_dir"
  # The previous service container is gone before Railway mounts this single-replica
  # volume here. Chromium's process locks refer to that container, not saved logins.
  # Match only its three symlinks, without following any directory symlinks.
  find "$data_dir" -type l \( \
    -path '*/.taut/browser/profile/SingletonLock' -o \
    -path '*/.taut/browser/profile/SingletonCookie' -o \
    -path '*/.taut/browser/profile/SingletonSocket' \
  \) -delete
  exec setpriv --reuid=1000 --regid=1000 --init-groups --no-new-privs "$@"
fi
exec "$@"
