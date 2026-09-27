#!/bin/sh
# Pull the latest main branch and rebuild the Metarr container.
# On the Plex machine: sudo /opt/metarr/deploy.sh
#
# Optional: match media ownership so disc remux can write MKVs:
#   export METARR_UID=$(stat -c %u /mnt/media/Movies)
#   export METARR_GID=$(stat -c %g /mnt/media/Movies)
# On NFS, avoid METARR_UID=0 (root_squash maps root to nobody).
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
if [ "$(id -u)" -ne 0 ]; then
  exec sudo --preserve-env=METARR_UID,METARR_GID -- "$root/$(basename "$0")" "$@"
fi

cd "$root"
git pull --ff-only

media_sample=""
if [ -d /mnt/media ]; then
  opts=$(findmnt -no OPTIONS /mnt/media 2>/dev/null || true)
  case ",$opts," in
    *,ro,*)
      echo "Warning: /mnt/media is mounted read-only on the host ($opts). Disc remux cannot write MKVs until you remount it read-write." >&2
      echo "  findmnt /mnt/media" >&2
      echo "  mount -o remount,rw /mnt/media" >&2
      ;;
  esac
  # Prefer a library folder (Movies/TV) — the NFS mount root is often not group-writable.
  for candidate in /mnt/media/Movies /mnt/media/TV /mnt/media; do
    if [ -d "$candidate" ]; then
      media_sample=$candidate
      break
    fi
  done
fi

if [ -d /mnt/media ] && [ -z "${METARR_UID:-}" ] && [ -z "${METARR_GID:-}" ]; then
  if [ -n "$media_sample" ] && [ -d "$media_sample" ]; then
    METARR_UID=$(stat -c %u "$media_sample")
    METARR_GID=$(stat -c %g "$media_sample")
    # NFS root_squash: client uid 0 becomes nobody and cannot write mode 775 folders.
    if [ "$METARR_UID" = "0" ]; then
      alt=$(find "$media_sample" -mindepth 1 -maxdepth 3 \( -type f -o -type d \) -printf '%u\n' 2>/dev/null | awk '$1 != "0" { print; exit }' || true)
      if [ -z "$alt" ]; then
        # First named user in the media group, else a common non-root uid.
        alt=$(getent group "$METARR_GID" 2>/dev/null | cut -d: -f4 | cut -d, -f1 || true)
      fi
      if [ -z "$alt" ] || [ "$alt" = "0" ]; then
        alt=1000
      fi
      echo "Media sample $media_sample is owned by uid 0; NFS root_squash would block root writes."
      echo "Using METARR_UID=$alt METARR_GID=$METARR_GID (group write) instead of uid 0."
      METARR_UID=$alt
    else
      echo "Using METARR_UID=$METARR_UID METARR_GID=$METARR_GID from $media_sample"
    fi
    export METARR_UID METARR_GID
  fi
fi

docker compose up --build -d

i=0
while [ "$i" -lt 30 ]; do
  if curl -4 -fsS -m 3 -o /dev/null http://127.0.0.1:4317/; then
    echo "Metarr is up at http://127.0.0.1:4317/"
    probe_dir=${media_sample:-/mnt/media}
    probe_uid=${METARR_UID:-0}
    probe_gid=${METARR_GID:-0}
    if [ -d "$probe_dir" ] && docker compose exec -T -u "${probe_uid}:${probe_gid}" metarr \
      sh -c "test -d \"$probe_dir\" && touch \"$probe_dir/.metarr-write-test\" && rm -f \"$probe_dir/.metarr-write-test\"" 2>/dev/null; then
      echo "Write access to $probe_dir as ${probe_uid}:${probe_gid} is OK."
    else
      echo "Warning: Metarr cannot write to $probe_dir as uid ${probe_uid} gid ${probe_gid}." >&2
      echo "  findmnt /mnt/media should show rw (not ro)." >&2
      echo "  On NFS, do not run as uid 0 (root_squash). Set METARR_UID to a non-root user and METARR_GID to the media group (often 1002), then redeploy:" >&2
      echo "    export METARR_UID=1000 METARR_GID=\$(stat -c %g /mnt/media/Movies)" >&2
      echo "    sudo --preserve-env=METARR_UID,METARR_GID /opt/metarr/deploy.sh" >&2
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
