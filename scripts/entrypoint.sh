#!/bin/sh
# Run Metarr as METARR_UID/METARR_GID when set, after making /app/data writable for that user.
# On NFS media shares, avoid uid 0: root_squash maps root to nobody and blocks writes.
set -eu

uid="${METARR_UID:-0}"
gid="${METARR_GID:-0}"

mkdir -p /app/data/remux-work /app/data/makemkv-home /app/data/whisper

if [ "$uid" != "0" ] || [ "$gid" != "0" ]; then
  chown -R "$uid:$gid" /app/data || true
fi

if [ "$uid" = "0" ] && [ "$gid" = "0" ]; then
  exec node server.js
fi

if [ "$uid" = "0" ] && [ "$gid" != "0" ]; then
  echo "METARR_UID=0 with METARR_GID=$gid: on NFS, root is often squashed and cannot write. Prefer a non-zero METARR_UID." >&2
fi

if command -v setpriv >/dev/null 2>&1; then
  # Keep a real primary gid even when dropping from root so group-writable media (775) works.
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups node server.js
fi

if [ "$uid" != "0" ] && command -v runuser >/dev/null 2>&1; then
  exec runuser -u "#$uid" -- node server.js
fi

echo "METARR_UID=$uid METARR_GID=$gid was set, but setpriv/runuser cannot apply them; starting as root." >&2
exec node server.js
