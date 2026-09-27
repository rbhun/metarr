#!/bin/sh
# Pull the latest main branch and rebuild the Metarr container.
# On the Plex machine: sudo /opt/metarr/deploy.sh
#
# Optional: match media ownership so disc remux can write MKVs:
#   export METARR_UID=1000
#   export METARR_GID=$(stat -c %g /mnt/media/Movies)
# On NFS, avoid METARR_UID=0 (root_squash maps root to nobody).
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
if [ "$(id -u)" -ne 0 ]; then
  exec sudo --preserve-env=METARR_UID,METARR_GID -- "$root/$(basename "$0")" "$@"
fi

cd "$root"
git pull --ff-only

# Pick a title folder under Movies/TV — remux writes beside the disc, not into Movies itself.
# The library root is often 755 while title folders are 775.
media_sample=""
probe_dir=""
if [ -d /mnt/media ]; then
  opts=$(findmnt -no OPTIONS /mnt/media 2>/dev/null || true)
  case ",$opts," in
    *,ro,*)
      echo "Warning: /mnt/media is mounted read-only on the host ($opts). Disc remux cannot write MKVs until you remount it read-write." >&2
      echo "  findmnt /mnt/media" >&2
      echo "  mount -o remount,rw /mnt/media" >&2
      ;;
  esac
  for library in /mnt/media/Movies /mnt/media/TV; do
    if [ -d "$library" ]; then
      media_sample=$library
      probe_dir=$(find "$library" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1 || true)
      [ -n "$probe_dir" ] && break
    fi
  done
  if [ -z "$media_sample" ] && [ -d /mnt/media ]; then
    media_sample=/mnt/media
  fi
  if [ -z "$probe_dir" ]; then
    probe_dir=${media_sample:-/mnt/media}
  fi
fi

pick_non_root_uid() {
  sample=$1
  gid=$2
  alt=$(find "$sample" -mindepth 0 -maxdepth 3 \( -type f -o -type d \) -printf '%u\n' 2>/dev/null | awk '$1 != "0" { print; exit }' || true)
  if [ -z "$alt" ] || [ "$alt" = "0" ]; then
    alt=$(getent group "$gid" 2>/dev/null | cut -d: -f4 | cut -d, -f1 || true)
  fi
  if [ -z "$alt" ] || [ "$alt" = "0" ]; then
    alt=1000
  fi
  echo "$alt"
}

if [ -d /mnt/media ] && [ -z "${METARR_UID:-}" ] && [ -z "${METARR_GID:-}" ]; then
  ownership_dir=${probe_dir:-$media_sample}
  if [ -n "$ownership_dir" ] && [ -d "$ownership_dir" ]; then
    METARR_UID=$(stat -c %u "$ownership_dir")
    METARR_GID=$(stat -c %g "$ownership_dir")
    if [ "$METARR_UID" = "0" ]; then
      METARR_UID=$(pick_non_root_uid "$ownership_dir" "$METARR_GID")
      echo "Media sample $ownership_dir is owned by uid 0; NFS root_squash would block root writes."
      echo "Using METARR_UID=$METARR_UID METARR_GID=$METARR_GID (group write) instead of uid 0."
    else
      echo "Using METARR_UID=$METARR_UID METARR_GID=$METARR_GID from $ownership_dir"
    fi
    export METARR_UID METARR_GID
  fi
fi

docker compose up --build -d

host_touch_as() {
  dir=$1
  uid=$2
  gid=$3
  marker="$dir/.metarr-write-test-host"
  if command -v setpriv >/dev/null 2>&1; then
    setpriv --reuid="$uid" --regid="$gid" --clear-groups -- touch "$marker" || return $?
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "#$uid" -g "#$gid" -- touch "$marker" || return $?
  else
    touch "$marker" || return $?
  fi
  rm -f "$marker"
  return 0
}

i=0
while [ "$i" -lt 30 ]; do
  if curl -4 -fsS -m 3 -o /dev/null http://127.0.0.1:4317/; then
    echo "Metarr is up at http://127.0.0.1:4317/"
    probe_uid=${METARR_UID:-0}
    probe_gid=${METARR_GID:-0}
    if [ -z "$probe_dir" ] || [ ! -d "$probe_dir" ]; then
      echo "Warning: no media folder found under /mnt/media to probe for write access." >&2
      exit 0
    fi

    echo "Checking write access in $probe_dir as ${probe_uid}:${probe_gid}"
    echo "(remux writes beside the disc; Movies/ itself is often not group-writable)."
    ls -ld /mnt/media /mnt/media/Movies "$probe_dir" 2>/dev/null || ls -ld "$probe_dir" 2>/dev/null || true

    host_ok=0
    if host_err=$(host_touch_as "$probe_dir" "$probe_uid" "$probe_gid" 2>&1); then
      host_ok=1
      echo "Host write to $probe_dir as ${probe_uid}:${probe_gid} is OK."
    else
      echo "Host write failed as ${probe_uid}:${probe_gid}: ${host_err:-unknown error}" >&2
    fi

    container_ok=0
    if container_err=$(docker compose exec -T -u "${probe_uid}:${probe_gid}" metarr \
      sh -c "touch \"$probe_dir/.metarr-write-test\" && rm -f \"$probe_dir/.metarr-write-test\"" 2>&1); then
      container_ok=1
      echo "Container write to $probe_dir as ${probe_uid}:${probe_gid} is OK."
    else
      echo "Warning: Metarr container cannot write to $probe_dir as uid ${probe_uid} gid ${probe_gid}." >&2
      echo "  ${container_err:-touch failed}" >&2
      echo "  findmnt /mnt/media should show rw (not ro)." >&2
      if [ "$host_ok" -eq 0 ]; then
        echo "  Host also cannot write there as ${probe_uid}:${probe_gid}." >&2
        echo "  On the NFS server (192.168.20.2), grant group write on title folders or chown them to a client uid that matches METARR_UID:" >&2
        echo "    ls -ld \"$probe_dir\"" >&2
        echo "    export METARR_UID=<writable-uid> METARR_GID=\$(stat -c %g \"$probe_dir\")" >&2
        echo "    sudo --preserve-env=METARR_UID,METARR_GID /opt/metarr/deploy.sh" >&2
      else
        echo "  Host can write, but the container cannot — check the Docker volume mount for /mnt/media." >&2
      fi
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
