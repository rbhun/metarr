#!/bin/sh
# Pull the latest main branch and rebuild the Metarr container.
# On the Plex machine: sudo /opt/metarr/deploy.sh
#
# Settings live in /opt/metarr/.env (template: metarr.env.example).
# Deploy never deletes or moves anything under /mnt/media; the write check
# creates one empty marker file and removes only that file.
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
  cp metarr.env.example .env
  echo "Wrote $root/.env from metarr.env.example."
fi
if grep -q '^METARR_UID=1000$' .env; then
  sed -i 's/^METARR_UID=1000$/METARR_UID=1500/' .env
  echo "Changed METARR_UID from 1000 to 1500 in .env: uid 1000 maps to a restricted account on the NFS server."
fi
. ./.env
METARR_UID=${METARR_UID:-1500}
METARR_GID=${METARR_GID:-1002}
echo "Running as ${METARR_UID}:${METARR_GID}, umask ${UMASK:-002}$( [ "${METARR_DRY_RUN:-0}" = "1" ] && echo ', dry run (nothing is written to /mnt/media)')."

# MakeMKV is compiled from a Debian image. That image is pulled only when the
# binaries are not already on this machine. Later deploys copy the saved copy.
install_makemkv() {
  version=$(sed -n 's/^ARG MAKEMKV_VERSION=//p' "$root/Dockerfile.makemkv" | head -n 1)
  [ -n "$version" ] || version=1.18.4
  dest="$root/vendor/makemkv"
  # makemkvcon carries its own version ("v1.18.4 linux"), so a saved copy or an
  # image with another MakeMKV is rebuilt instead of reused.
  complete() {
    [ -x "$dest/bin/makemkvcon" ] && [ -x "$dest/bin/mmccextr" ] && [ -f "$dest/share/appdata.tar" ] \
      && grep -aqF "v${version} linux" "$dest/bin/makemkvcon"
  }
  if complete; then
    echo "MakeMKV ${version} is already installed."
    return
  fi
  if [ -x "$dest/bin/makemkvcon" ]; then
    echo "The saved MakeMKV is not ${version}. Replacing it."
  fi

  current_image() {
    id=$(docker compose ps -aq metarr 2>/dev/null | head -n 1 || true)
    if [ -n "$id" ]; then
      docker inspect -f '{{.Image}}' "$id" 2>/dev/null || true
      return
    fi
    docker images -q --filter label=com.docker.compose.service=metarr 2>/dev/null | head -n 1 || true
  }

  extract_makemkv() {
    image=$1
    rm -rf "$dest"
    mkdir -p "$dest/bin" "$dest/lib" "$dest/share"
    # share/ holds appdata.tar: the default profile and the Blu-ray data files.
    docker run --rm --entrypoint sh -v "$dest:/export" "$image" -c 'cp -aL /usr/bin/makemkvcon /usr/bin/mmgplsrv /usr/bin/mmccextr /export/bin/ && cp -aL /usr/lib/libmakemkv.so.1 /usr/lib/libdriveio.so.0 /usr/lib/libmmbd.so.0 /export/lib/ && cp -aL /usr/share/MakeMKV/. /export/share/'
  }

  image=$(current_image)
  if [ -n "$image" ] && docker run --rm --entrypoint sh "$image" -c "test -x /usr/bin/makemkvcon && test -x /usr/bin/mmccextr && test -f /usr/share/MakeMKV/appdata.tar && grep -aqF 'v${version} linux' /usr/bin/makemkvcon"; then
    echo "MakeMKV ${version} is already in the current image. Copying it out."
    extract_makemkv "$image" || rm -rf "$dest"
  fi
  if ! complete; then
    echo "MakeMKV ${version} is missing. Downloading and building it."
    docker build -f "$root/Dockerfile.makemkv" -t "metarr-makemkv:${version}" "$root"
    extract_makemkv "metarr-makemkv:${version}"
  fi
  if ! complete; then
    echo "MakeMKV ${version} could not be installed." >&2
    exit 1
  fi
  printf '%s\n' "$version" > "$dest/VERSION"
  echo "MakeMKV ${version} is installed."
}

install_makemkv

# Settings → Update Metarr drops run/deploy-request; a systemd path unit on this
# machine sees it and runs scripts/deploy-watch.sh, which runs this script.
install_ui_deploy() {
  mkdir -p "$root/run"
  chown "$METARR_UID:$METARR_GID" "$root/run"
  chmod 0775 "$root/run"
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    rm -f "$root/run/watcher"
    echo "systemd is not running here, so Settings → Update Metarr stays off. Deploy from the console instead."
    return
  fi
  cat > /etc/systemd/system/metarr-deploy.path <<EOF
[Unit]
Description=Watch for Metarr update requests from Settings

[Path]
PathExists=$root/run/deploy-request
Unit=metarr-deploy.service

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/metarr-deploy.service <<EOF
[Unit]
Description=Update Metarr (requested from Settings)

[Service]
Type=oneshot
ExecStart=/bin/sh $root/scripts/deploy-watch.sh
TimeoutStartSec=3600
EOF
  systemctl daemon-reload
  if systemctl enable --now metarr-deploy.path >/dev/null 2>&1; then
    printf '%s\n' "$root" > "$root/run/watcher"
    chmod 644 "$root/run/watcher"
    echo "Settings → Update Metarr is on (systemd unit metarr-deploy.path)."
  else
    rm -f "$root/run/watcher"
    echo "Could not start metarr-deploy.path, so Settings → Update Metarr stays off." >&2
  fi
}

install_ui_deploy

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

if [ "${METARR_DRY_RUN:-0}" = "1" ]; then
  echo "Dry run: skipped the write check."
  exit 0
fi

folder=$(find /mnt/media/Movies -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1 || true)
[ -n "$folder" ] || folder=/mnt/media
marker="$folder/.metarr-write-test-$$"

echo "Write check in $folder:"
if container_err=$(docker compose exec -T metarr setpriv --reuid="$METARR_UID" --regid="$METARR_GID" --clear-groups \
  sh -c 'umask "${UMASK:-002}" && touch "$1" && rm "$1"' sh "$marker" 2>&1); then
  echo "  OK"
else
  echo "  $container_err"
fi
