#!/bin/sh
# Run on the host by metarr-deploy.service when Settings → Update Metarr leaves
# run/deploy-request. Runs the normal deploy.sh and records its output and result
# in run/, which the container can read. The container can only ask; it never
# runs anything on the host itself.
set -u

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
run="$root/run"
rm -f "$run/deploy-request"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
commit() { git -C "$root" rev-parse --short HEAD 2>/dev/null || echo unknown; }

started=$(now)
before=$(commit)

# state, finishedAt (JSON), exitCode (JSON), after (JSON)
status() {
  tmp="$run/deploy-status.json.tmp"
  printf '{"state":"%s","startedAt":"%s","finishedAt":%s,"exitCode":%s,"before":"%s","after":%s}\n' \
    "$1" "$started" "$2" "$3" "$before" "$4" > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$run/deploy-status.json"
}

status running null null null
: > "$run/deploy.log"
chmod 644 "$run/deploy.log"
echo "Update requested from Metarr Settings at $started." >> "$run/deploy.log"

"$root/deploy.sh" >> "$run/deploy.log" 2>&1
code=$?

if [ "$code" -eq 0 ]; then state=done; else state=failed; fi
status "$state" "\"$(now)\"" "$code" "\"$(commit)\""
exit "$code"
