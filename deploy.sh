#!/bin/sh
# Pull the latest main branch and rebuild the Metarr container.
# On the Plex machine: sudo /opt/metarr/deploy.sh
#
# MEDIA SAFETY: this script never deletes library files and never runs
# `docker volume rm` on a media volume. Write probes only create/remove tiny
# `.metarr-write-test*` marker files. Switching to direct NFS uses a new
# volume name (media_nfs) so Compose does not recreate/destroy anything.
#
# Optional: match media ownership so disc remux can write MKVs beside any disc:
#   export METARR_UID=1000
#   export METARR_GID=$(stat -c %g /mnt/media/Movies)
# On NFS, avoid METARR_UID=0 (root_squash maps root to nobody).
#
# If this host's /mnt/media returns EROFS but other NFS clients can write:
#   export METARR_NFS_ADDR=192.168.20.2
#   export METARR_NFS_EXPORT=/tank/media
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
if [ "$(id -u)" -ne 0 ]; then
  exec sudo --preserve-env=METARR_UID,METARR_GID,METARR_NFS_ADDR,METARR_NFS_EXPORT,METARR_MEDIA_VOLUME -- "$root/$(basename "$0")" "$@"
fi

cd "$root"

# Persist NFS choice across deploys (gitignored). Never stores credentials.
NFS_STATE="$root/.metarr-nfs.env"

# docker-compose.media.yml is rewritten by this script. Discard local edits so
# git pull is not blocked (library data is never touched).
capture_nfs_from_media_yml() {
  [ -f docker-compose.media.yml ] || return 0
  [ -n "${METARR_NFS_ADDR:-}" ] && [ -n "${METARR_NFS_EXPORT:-}" ] && return 0
  [ -f "$NFS_STATE" ] && return 0
  if grep -q 'type: nfs' docker-compose.media.yml 2>/dev/null; then
    addr=$(sed -n 's/.*addr=\([^,]*\).*/\1/p' docker-compose.media.yml | head -n 1 || true)
    export_path=$(sed -n 's/.*device: ":\([^"]*\)".*/\1/p' docker-compose.media.yml | head -n 1 || true)
    if [ -n "$addr" ] && [ -n "$export_path" ]; then
      METARR_NFS_ADDR=$addr
      METARR_NFS_EXPORT=$export_path
      export METARR_NFS_ADDR METARR_NFS_EXPORT
      echo "Remembered direct NFS ${addr}:${export_path} from local docker-compose.media.yml."
    fi
  fi
}

capture_nfs_from_media_yml
if git status --porcelain -- docker-compose.media.yml 2>/dev/null | grep -q .; then
  echo "Resetting generated docker-compose.media.yml so git pull can update Metarr."
  git checkout -- docker-compose.media.yml
fi

git pull --ff-only

if [ -f "$NFS_STATE" ] && [ -z "${METARR_NFS_ADDR:-}" ] && [ -z "${METARR_NFS_EXPORT:-}" ]; then
  # shellcheck disable=SC1090
  . "$NFS_STATE"
fi

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.media.yml"

write_media_bind() {
  METARR_MEDIA_VOLUME=media
  export METARR_MEDIA_VOLUME
  cat > docker-compose.media.yml <<'EOF'
# Host bind of /mnt/media. Attach-only — does not copy or delete library files.
volumes:
  media:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /mnt/media
EOF
}

write_media_nfs() {
  addr=$1
  export_path=$2
  # New volume name avoids Compose "recreate volume / data will be lost" prompts.
  # Old bind volume "media" is left unused; nothing on the NAS is removed.
  METARR_MEDIA_VOLUME=media_nfs
  export METARR_MEDIA_VOLUME
  cat > docker-compose.media.yml <<EOF
# Direct NFS mount (separate volume name from the host bind).
# Mount-only: Docker does not own or delete files on the NFS server.
volumes:
  media_nfs:
    driver: local
    driver_opts:
      type: nfs
      o: addr=${addr},rw,nfsvers=4.2,hard,timeo=600,retrans=2
      device: ":${export_path}"
EOF
  cat > "$NFS_STATE" <<EOF
METARR_NFS_ADDR=${addr}
METARR_NFS_EXPORT=${export_path}
METARR_MEDIA_VOLUME=media_nfs
EOF
  echo "Using direct NFS mount ${addr}:${export_path} -> /mnt/media (volume media_nfs; no media data deleted)."
}

nfs_source_from_host() {
  src=$(findmnt -no SOURCE -t nfs,nfs4 /mnt/media 2>/dev/null | tail -n 1 || true)
  if [ -z "$src" ]; then
    src=$(findmnt -no SOURCE /mnt/media 2>/dev/null | grep -E ':/' | tail -n 1 || true)
  fi
  echo "$src"
}

if [ -n "${METARR_NFS_ADDR:-}" ] && [ -n "${METARR_NFS_EXPORT:-}" ]; then
  write_media_nfs "$METARR_NFS_ADDR" "$METARR_NFS_EXPORT"
elif [ ! -f docker-compose.media.yml ]; then
  write_media_bind
else
  METARR_MEDIA_VOLUME=${METARR_MEDIA_VOLUME:-media}
  export METARR_MEDIA_VOLUME
fi

library_dir=""
sample_title=""
if [ -d /mnt/media ]; then
  opts=$(findmnt -no OPTIONS /mnt/media 2>/dev/null || true)
  case ",$opts," in
    *,ro,*)
      echo "Warning: /mnt/media is mounted read-only on the host ($opts)." >&2
      echo "  findmnt /mnt/media; mount -o remount,rw /mnt/media" >&2
      echo "  Or set METARR_NFS_ADDR / METARR_NFS_EXPORT so Docker mounts NFS itself." >&2
      ;;
  esac
  for library in /mnt/media/Movies /mnt/media/TV; do
    if [ -d "$library" ]; then
      library_dir=$library
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
  ownership_dir=${library_dir:-}
  if [ -z "$ownership_dir" ] || [ ! -d "$ownership_dir" ]; then
    ownership_dir=$sample_title
  fi
  if [ -n "$ownership_dir" ] && [ -d "$ownership_dir" ]; then
    METARR_UID=$(stat -c %u "$ownership_dir")
    METARR_GID=$(stat -c %g "$ownership_dir")
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

$COMPOSE up --build -d

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

remove_write_probe_dir() {
  # Only remove the temporary probe directory we created; never a title folder.
  dir=$1
  base=$(basename "$dir")
  if [ "$base" != ".metarr-write-probe" ]; then
    return 0
  fi
  case "$dir" in
    /mnt/media/*/.metarr-write-probe)
      rm -rf "$dir" 2>/dev/null || true
      ;;
  esac
}

print_mount_diagnostics() {
  echo "--- mount diagnostics ---" >&2
  findmnt -R /mnt/media 2>/dev/null || findmnt /mnt/media 2>/dev/null || true
  echo "--- /proc/mounts (media) ---" >&2
  grep -E '[[:space:]]/mnt/media|/tank/media' /proc/mounts 2>/dev/null || true
  if [ -n "${1:-}" ]; then
    echo "--- mountpoint? $1 ---" >&2
    mountpoint "$1" 2>/dev/null || true
    findmnt "$1" 2>/dev/null || true
  fi
}

switch_to_direct_nfs_and_retry() {
  src=$(nfs_source_from_host)
  addr=${METARR_NFS_ADDR:-}
  export_path=${METARR_NFS_EXPORT:-}
  if [ -z "$addr" ] || [ -z "$export_path" ]; then
    case "$src" in
      *:*)
        addr=${src%%:*}
        export_path=${src#*:}
        ;;
    esac
  fi
  if [ -z "$addr" ] || [ -z "$export_path" ]; then
    echo "Could not detect NFS server:export from findmnt." >&2
    echo "If other machines can write this share, mount it in Docker directly:" >&2
    echo "  export METARR_NFS_ADDR=<nfs-server-ip>" >&2
    echo "  export METARR_NFS_EXPORT=/tank/media   # path on the server" >&2
    echo "  sudo --preserve-env=METARR_UID,METARR_GID,METARR_NFS_ADDR,METARR_NFS_EXPORT /opt/metarr/deploy.sh" >&2
    return 1
  fi
  write_media_nfs "$addr" "$export_path"
  echo "Switching the container to volume media_nfs (mount-only; library files are not deleted)."
  $COMPOSE up -d
  return 0
}

i=0
while [ "$i" -lt 30 ]; do
  if curl -4 -fsS -m 3 -o /dev/null http://127.0.0.1:4317/; then
    echo "Metarr is up at http://127.0.0.1:4317/"
    probe_uid=${METARR_UID:-0}
    probe_gid=${METARR_GID:-0}

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
      probe_dir=${library_dir:-/mnt/media/Movies}
      echo "No host-writable sample folder; will probe $probe_dir inside the container only."
    else
      if [ "$created_probe" -eq 1 ]; then
        echo "No title folders yet — sampling temporary $probe_dir as ${probe_uid}:${probe_gid}."
      else
        echo "Sampling write access in $probe_dir as ${probe_uid}:${probe_gid}."
        echo "This is only a canary: the same uid/gid is used for every remux; each job checks its own disc folder."
      fi
      ls -ld /mnt/media ${library_dir:+"$library_dir"} "$probe_dir" 2>/dev/null || true
    fi

    host_ok=0
    host_err=""
    if [ -d "$probe_dir" ] && host_err=$(host_touch_as "$probe_dir" "$probe_uid" "$probe_gid" 2>&1); then
      host_ok=1
      echo "Host write as ${probe_uid}:${probe_gid} is OK."
    elif [ -n "$host_err" ]; then
      echo "Host write failed as ${probe_uid}:${probe_gid}: ${host_err}" >&2
    fi

    container_ok=0
    container_err=""
    if container_err=$($COMPOSE exec -T -u "${probe_uid}:${probe_gid}" metarr \
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
        echo "EROFS on this host/container path — not a Metarr UID/GID issue." >&2
        echo "Other NFS clients can write while this machine's /mnt/media path returns EROFS;" >&2
        echo "often the host autofs/NFS client mount is broken or ro, while Plex uses its own mount." >&2
        print_mount_diagnostics "$probe_dir"
        if [ "$container_ok" -eq 0 ]; then
          echo "Retrying with a direct NFS mount inside Docker (mount-only; will not delete library files)..." >&2
          if switch_to_direct_nfs_and_retry; then
            sleep 2
            if container_err=$($COMPOSE exec -T -u "${probe_uid}:${probe_gid}" metarr \
              sh -c "touch \"$probe_dir/.metarr-write-test\" && rm -f \"$probe_dir/.metarr-write-test\"" 2>&1); then
              echo "Container write as ${probe_uid}:${probe_gid} is OK after direct NFS mount."
              container_ok=1
            else
              echo "Still cannot write after direct NFS mount: ${container_err:-failed}" >&2
              echo "Check that this host's IP is allowed read-write on the NFS export (laptop/Plex may use a different client IP)." >&2
            fi
          fi
        fi
        ;;
      *)
        if [ "$container_ok" -eq 0 ]; then
          echo "  Unix mode/owner still apply when the mount is rw." >&2
          if [ "$host_ok" -eq 0 ]; then
            echo "  Host also cannot write as ${probe_uid}:${probe_gid}." >&2
            echo "    export METARR_UID=<writable-uid> METARR_GID=${probe_gid}" >&2
            echo "    sudo --preserve-env=METARR_UID,METARR_GID /opt/metarr/deploy.sh" >&2
          else
            echo "  Host can write, but the container cannot — check the Docker media volume." >&2
          fi
        fi
        ;;
    esac

    if [ "$created_probe" -eq 1 ]; then
      remove_write_probe_dir "$probe_dir"
    fi
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "The container started, but http://127.0.0.1:4317/ did not answer." >&2
$COMPOSE ps
$COMPOSE logs --tail 40
exit 1
