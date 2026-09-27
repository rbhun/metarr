#!/bin/sh
# Run Metarr as METARR_UID/METARR_GID when set, after making /app/data writable for that user.
set -eu

uid="${METARR_UID:-0}"
gid="${METARR_GID:-0}"

mkdir -p /app/data/remux-work /app/data/makemkv-home /app/data/whisper

if [ "$uid" != "0" ] || [ "$gid" != "0" ]; then
  chown -R "$uid:$gid" /app/data || true
fi

if [ "$uid" = "0" ]; then
  exec node server.js
fi

if command -v setpriv >/dev/null 2>&1; then
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups node server.js
fi

if command -v runuser >/dev/null 2>&1; then
  exec runuser -u "#$uid" -- node server.js
fi

echo "METARR_UID=$uid was set, but setpriv/runuser is missing; starting as root." >&2
exec node server.js
