#!/bin/sh
# Pull the latest main branch and rebuild the Metarr container.
# On the Plex machine: sudo /opt/metarr/deploy.sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -- "$root/$(basename "$0")" "$@"
fi

cd "$root"
git pull --ff-only
docker compose up --build -d

i=0
while [ "$i" -lt 30 ]; do
  if curl -4 -fsS -m 3 -o /dev/null http://127.0.0.1:4317/; then
    echo "Metarr is up at http://127.0.0.1:4317/"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "The container started, but http://127.0.0.1:4317/ did not answer." >&2
docker compose ps
docker compose logs --tail 40
exit 1
