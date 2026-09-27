#!/bin/sh
# Pull the latest main branch and rebuild the Metarr container.
# On the Plex machine: sudo /opt/metarr/deploy.sh
#
# Optional: match media ownership so disc remux can write MKVs:
#   export METARR_UID=$(stat -c %u /mnt/media/Movies)
#   export METARR_GID=$(stat -c %g /mnt/media/Movies)
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
if [ "$(id -u)" -ne 0 ]; then
  exec sudo --preserve-env=METARR_UID,METARR_GID -- "$root/$(basename "$0")" "$@"
fi

cd "$root"
git pull --ff-only

if [ -d /mnt/media ] && [ -z "${METARR_UID:-}" ] && [ -z "${METARR_GID:-}" ]; then
  sample=$(find /mnt/media -mindepth 1 -maxdepth 2 -type d 2>/dev/null | head -n 1 || true)
  if [ -n "$sample" ]; then
    METARR_UID=$(stat -c %u "$sample")
    METARR_GID=$(stat -c %g "$sample")
    export METARR_UID METARR_GID
    echo "Using METARR_UID=$METARR_UID METARR_GID=$METARR_GID from $sample"
  fi
fi

docker compose up --build -d

i=0
while [ "$i" -lt 30 ]; do
  if curl -4 -fsS -m 3 -o /dev/null http://127.0.0.1:4317/; then
    echo "Metarr is up at http://127.0.0.1:4317/"
    if docker compose exec -T metarr sh -c 'test -d /mnt/media && touch /mnt/media/.metarr-write-test && rm -f /mnt/media/.metarr-write-test' 2>/dev/null; then
      echo "Write access to /mnt/media is OK."
    else
      echo "Warning: Metarr cannot write to /mnt/media. Set METARR_UID/METARR_GID to the media owner and redeploy." >&2
    fi
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "The container started, but http://127.0.0.1:4317/ did not answer." >&2
docker compose ps
docker compose logs --tail 40
exit 1
