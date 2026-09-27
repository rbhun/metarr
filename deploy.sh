#!/bin/sh
# Pull the latest main branch and rebuild the Metarr container.
# On the Plex machine: sudo /opt/metarr/deploy.sh
#
# Optional: match media ownership so disc remux can write MKVs beside any disc:
#   export METARR_UID=1000
#   export METARR_GID=$(stat -c %g /mnt/media/Movies)
# On NFS, avoid METARR_UID=0 (root_squash maps root to nobody).
#
# A mount showing "rw" means the filesystem is not read-only. Unix mode/owner
# still decide who can create files. Remux writes inside each title folder, and
# runs as METARR_UID/METARR_GID for every job — deploy only samples one folder.
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
if [ "$(id -u)" -ne 0 ]; then
  exec sudo --preserve-env=METARR_UID,METARR_GID -- "$root/$(basename "$0")" "$@"
fi

cd "$root"
git pull --ff-only

library_dir=""
sample_title=""
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
      library_dir=$library
      # Any title folder is enough — same METARR_UID/GID is used for every remux.
      sample_title=$(find "$library" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1 || true)
      [ -n "$sample_title" ] && break
    fi
  done
  if [ -z "$library_dir" ] && [ -d /mnt/media ]; then
    library_dir=/mnt/media
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
  # Prefer library group (applies to the whole library), fall back to a title folder.
  ownership_dir=${library_dir:-}
  if [ -z "$ownership_dir" ] || [ ! -d "$ownership_dir" ]; then
    ownership_dir=$sample_title
  fi
  if [ -n "$ownership_dir" ] && [ -d "$ownership_dir" ]; then
    METARR_UID=$(stat -c %u "$ownership_dir")
    METARR_GID=$(stat -c %g "$ownership_dir")
    # Title folders often carry the media group more accurately than Movies/ itself.
    if [ -n "$sample_title" ] && [ -d "$sample_title" ]; then
      METARR_GID=$(stat -c %g "$sample_title")
      title_uid=$(stat -c %u "$sample_title")
      if [ "$title_uid" != "0" ]; then
        METARR_UID=$title_uid
      fi
    fi
    if [ "$METARR_UID" = "0" ]; then
      METARR_UID=$(pick_non_root_uid "${sample_title:-$ownership_dir}" "$METARR_GID")
      echo "Media is owned by uid 0; NFS root_squash would block root writes."
      echo "Using METARR_UID=$METARR_UID METARR_GID=$METARR_GID for every remux (group write)."
    else
      echo "Using METARR_UID=$METARR_UID METARR_GID=$METARR_GID for every remux (from $ownership_dir)."
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

    # Sample any existing title. Remux itself checks the target disc folder per job.
    probe_dir=$sample_title
    created_probe=0
    if [ -z "$probe_dir" ] && [ -n "$library_dir" ] && [ -d "$library_dir" ]; then
      probe_dir="$library_dir/.metarr-write-probe"
      if host_touch_as "$library_dir" "$probe_uid" "$probe_gid" 2>/dev/null; then
        if command -v setpriv >/dev/null 2>&1; then
          setpriv --reuid="$probe_uid" --regid="$probe_gid" --clear-groups -- mkdir -p "$probe_dir" 2>/dev/null || probe_dir=""
        else
          mkdir -p "$probe_dir" 2>/dev/null || probe_dir=""
        fi
        if [ -n "$probe_dir" ] && [ -d "$probe_dir" ]; then
          created_probe=1
        else
          probe_dir=""
        fi
      else
        probe_dir=""
      fi
    fi

    if [ -z "$probe_dir" ] || [ ! -d "$probe_dir" ]; then
      echo "No title folder to sample for a write check (and cannot create one under ${library_dir:-/mnt/media})."
      echo "Metarr will still run as ${probe_uid}:${probe_gid} and verify write access for each disc when you queue a remux."
      echo "Mount rw only means the share is not read-only; each title folder still needs group/owner write for that user."
      exit 0
    fi

    if [ "$created_probe" -eq 1 ]; then
      echo "No title folders yet — sampling temporary $probe_dir as ${probe_uid}:${probe_gid}."
    else
      echo "Sampling write access in $probe_dir as ${probe_uid}:${probe_gid}."
      echo "This is only a canary: the same uid/gid is used for every remux; each job checks its own disc folder."
    fi
    ls -ld /mnt/media ${library_dir:+"$library_dir"} "$probe_dir" 2>/dev/null || true

    host_ok=0
    host_err=""
    if host_err=$(host_touch_as "$probe_dir" "$probe_uid" "$probe_gid" 2>&1); then
      host_ok=1
      echo "Host write as ${probe_uid}:${probe_gid} is OK."
    else
      echo "Host write failed as ${probe_uid}:${probe_gid}: ${host_err:-unknown error}" >&2
    fi

    container_ok=0
    container_err=""
    if container_err=$(docker compose exec -T -u "${probe_uid}:${probe_gid}" metarr \
      sh -c "touch \"$probe_dir/.metarr-write-test\" && rm -f \"$probe_dir/.metarr-write-test\"" 2>&1); then
      container_ok=1
      echo "Container write as ${probe_uid}:${probe_gid} is OK."
    else
      echo "Warning: Metarr container cannot write as uid ${probe_uid} gid ${probe_gid}." >&2
      echo "  ${container_err:-touch failed}" >&2
    fi

    combined_err="$host_err $container_err"
    case "$combined_err" in
      *"Read-only file system"*|*"EROFS"*)
        echo "EROFS: the kernel refused the write as a read-only filesystem." >&2
        echo "Client findmnt can still list rw when the NFS server (or ZFS dataset) is read-only." >&2
        findmnt /mnt/media 2>/dev/null || true
        echo "On the NAS (source of /mnt/media), fix write access — METARR_UID/GID cannot fix EROFS:" >&2
        echo "  - NFS share: disable Read Only / remove 'ro' from export options" >&2
        echo "  - ZFS: zfs get readonly tank/media   (must be off)" >&2
        echo "  - Then on this host: mount -o remount,rw /mnt/media && sudo /opt/metarr/deploy.sh" >&2
        ;;
      *)
        if [ "$container_ok" -eq 0 ]; then
          echo "  findmnt rw means the share is not flagged ro locally; Unix mode/owner still apply." >&2
          if [ "$host_ok" -eq 0 ]; then
            echo "  Host also cannot write as ${probe_uid}:${probe_gid}." >&2
            echo "  On the NFS server, title folders need group write for gid ${probe_gid} (or ownership matching METARR_UID)." >&2
            echo "    export METARR_UID=<writable-uid> METARR_GID=${probe_gid}" >&2
            echo "    sudo --preserve-env=METARR_UID,METARR_GID /opt/metarr/deploy.sh" >&2
          else
            echo "  Host can write, but the container cannot — check the Docker volume mount for /mnt/media." >&2
          fi
        fi
        ;;
    esac

    if [ "$created_probe" -eq 1 ]; then
      rm -rf "$probe_dir" 2>/dev/null || true
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
