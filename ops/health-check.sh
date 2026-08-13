#!/usr/bin/env bash
set -euo pipefail

health_url="${ZAKAZ_HEALTH_URL:-http://127.0.0.1:3107/api/v1/health/ready}"
max_disk_percent="${ZAKAZ_MAX_DISK_PERCENT:-85}"
failure=""

if ! systemctl is-active --quiet zakaz-api; then failure="zakaz-api is not active"; fi
if test -z "$failure" && ! curl --fail --silent --show-error --max-time 12 "$health_url" >/tmp/zakaz-health.json; then failure="readiness endpoint failed"; fi
if test -z "$failure"; then
  if ! integration_failure="$(psql "$DATABASE_URL" -Atc "with claimed as (update monitoring_events set alerted_at=now() where id in (select id from monitoring_events where component in ('iiko_order','webhook') and severity in ('error','critical') and alerted_at is null order by created_at limit 10 for update skip locked) returning component,message) select coalesce(string_agg(component||': '||message,'; '),'') from claimed")"; then
    failure="database monitoring query failed"
  elif test -n "$integration_failure"; then
    failure="$integration_failure"
  fi
fi
disk_percent="$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
if test -z "$failure" && test "$disk_percent" -ge "$max_disk_percent"; then failure="disk usage is ${disk_percent}%"; fi

if test -n "$failure"; then
  logger -p daemon.err -t zakaz-health "$failure"
  if test -n "${ALERT_WEBHOOK_URL:-}"; then
    payload="$(ZAKAZ_ALERT_MESSAGE="$failure" ZAKAZ_ALERT_HOST="$(hostname)" node -e 'process.stdout.write(JSON.stringify({service:"brooklynbowl-kiosk",status:"error",message:process.env.ZAKAZ_ALERT_MESSAGE,host:process.env.ZAKAZ_ALERT_HOST,time:new Date().toISOString()}))')"
    curl --silent --show-error --max-time 10 -H 'Content-Type: application/json' -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
  echo "$failure" >&2
  exit 1
fi

logger -p daemon.info -t zakaz-health "ready; disk=${disk_percent}%"
