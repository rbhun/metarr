#!/bin/sh
# Pull the latest main branch and rebuild the Metarr container.
# On the Plex machine: sudo /opt/metarr/deploy.sh
#
# The container runs as METARR_UID/METARR_GID from /opt/metarr/.env
# (like PUID/PGID). Deploy never deletes or moves anything under /mnt/media;
# the write check creates one empty marker file and removes only that file.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -- "$root/$(basename "$0")" "$@"
fi
cd "$root"

# Older deploys generated this file; drop local edits so git pull works.
if [ -f docker-compose.media.yml ] && git ls-files --error-unmatch docker-compose.media.yml >/dev/null 2>&1; then
  git checkout -- docker-compose.media.yml
fi

before=$(git rev-parse HEAD)
git pull --ff-only
if [ "$(git rev-parse HEAD)" != "$before" ] && [ -z "${METARR_DEPLOY_REEXEC:-}" ]; then
  METARR_DEPLOY_REEXEC=1 exec "$root/deploy.sh" "$@"
fi

if [ ! -f .env ]; then
  uid=${SUDO_UID:-1000}
  gid=$(stat -c %g /mnt/media/Movies 2>/dev/null || stat -c %g /mnt/media 2>/dev/null || echo 0)
  printf 'METARR_UID=%s\nMETARR_GID=%s\n' "$uid" "$gid" > .env
  echo "Wrote $root/.env with METARR_UID=$uid METARR_GID=$gid. Edit it to match the user your other media apps use."
fi
. ./.env

docker compose up --build -d

i=0
until curl -4 -fsS -m 3 -o /dev/null http://127.0.0.1:4317/; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "The container started, but http://127.0.0.1:4317/ did not answer." >&2
    docker compose ps
    docker compose logs --tail 40
    exit 1
  fi
  sleep 1
done
echo "Metarr is up at http://127.0.0.1:4317/"

folder=$(find /mnt/media/Movies -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1 || true)
[ -n "$folder" ] || folder=/mnt/media
marker="$folder/.metarr-write-test"

echo "Write check in $folder as ${METARR_UID}:${METARR_GID}:"
if host_err=$(setpriv --reuid="$METARR_UID" --regid="$METARR_GID" --clear-groups -- touch "$marker" 2>&1); then
  rm -f "$marker"
  echo "  host:      OK"
else
  echo "  host:      $host_err"
fi
if container_err=$(docker compose exec -T -u "${METARR_UID}:${METARR_GID}" metarr touch "$marker" 2>&1); then
  docker compose exec -T -u "${METARR_UID}:${METARR_GID}" metarr rm -f "$marker"
  echo "  container: OK"
else
  echo "  container: $container_err"
fi
