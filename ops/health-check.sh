#!/usr/bin/env bash
set -euo pipefail

health_url="${ZAKAZ_HEALTH_URL:-http://127.0.0.1:3107/api/v1/health/ready}"
max_disk_percent="${ZAKAZ_MAX_DISK_PERCENT:-85}"
failure=""

if ! systemctl is-active --quiet zakaz-api; then failure="zakaz-api is not active"; fi
if test -z "$failure" && ! curl --fail --silent --show-error --max-time 12 "$health_url" >/tmp/zakaz-health.json; then failure="readiness endpoint failed"; fi
disk_percent="$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
if test -z "$failure" && test "$disk_percent" -ge "$max_disk_percent"; then failure="disk usage is ${disk_percent}%"; fi

if test -n "$failure"; then
  logger -p daemon.err -t zakaz-health "$failure"
  if test -n "${ALERT_WEBHOOK_URL:-}"; then
    payload="$(printf '{"service":"brooklynbowl-kiosk","status":"error","message":"%s","host":"%s"}' "$failure" "$(hostname)")"
    curl --silent --show-error --max-time 10 -H 'Content-Type: application/json' -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
  echo "$failure" >&2
  exit 1
fi

logger -p daemon.info -t zakaz-health "ready; disk=${disk_percent}%"
