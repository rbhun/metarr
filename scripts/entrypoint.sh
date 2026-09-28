#!/bin/sh
# Run Metarr as METARR_UID/METARR_GID with UMASK, after making /app/data writable for that user.
set -eu

uid="${METARR_UID:-1500}"
gid="${METARR_GID:-1002}"
# New media files must stay group-writable so Radarr/Sonarr can manage them.
umask "${UMASK:-002}"

mkdir -p /app/data/remux-work /app/data/retag-work /app/data/makemkv-home /app/data/whisper

if [ "$uid" != "0" ] || [ "$gid" != "0" ]; then
  chown -R "$uid:$gid" /app/data || true
fi

if [ "$uid" = "0" ] && [ "$gid" = "0" ]; then
  exec node server.js
fi

exec setpriv --reuid="$uid" --regid="$gid" --clear-groups node server.js
