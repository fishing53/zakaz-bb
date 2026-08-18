#!/usr/bin/env bash
set -euo pipefail

health_url="${BB_KIOSK_HEALTH_URL:-${ZAKAZ_HEALTH_URL:-http://127.0.0.1:3107/api/v1/health/ready}}"
max_disk_percent="${BB_KIOSK_MAX_DISK_PERCENT:-${ZAKAZ_MAX_DISK_PERCENT:-85}}"
failure=""

if ! systemctl is-active --quiet bb-kiosk-api; then failure="API приложения не запущен"; fi
if test -z "$failure" && ! curl --fail --silent --show-error --max-time 12 "$health_url" >/tmp/bb-kiosk-health.json; then failure="API приложения не прошёл проверку готовности"; fi
if test -z "$failure"; then
  if ! integration_failure="$(psql "$DATABASE_URL" -Atc "with claimed as (update monitoring_events set alerted_at=now() where id in (select id from monitoring_events where component in ('iiko_order','webhook') and severity in ('error','critical') and alerted_at is null order by created_at limit 10 for update skip locked) returning component,message) select coalesce(string_agg(component||': '||message,'; '),'') from claimed")"; then
    failure="Не удалось проверить события в базе данных"
  elif test -n "$integration_failure"; then
    failure="$integration_failure"
  fi
fi
if test -z "$failure"; then
  if ! menu_age_minutes="$(psql "$DATABASE_URL" -Atc "select coalesce(extract(epoch from (now()-max(updated_at)))/60,999999)::int from iiko_menu_items where not is_hidden")"; then
    failure="Не удалось проверить актуальность меню в базе данных"
  elif test "$menu_age_minutes" -ge "${BB_KIOSK_MAX_MENU_AGE_MINUTES:-${ZAKAZ_MAX_MENU_AGE_MINUTES:-30}}"; then
    failure="Меню iiko не обновлялось ${menu_age_minutes} минут"
  fi
fi
disk_percent="$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
if test -z "$failure" && test "$disk_percent" -ge "$max_disk_percent"; then failure="Диск сервера заполнен на ${disk_percent}%"; fi

if test -n "$failure"; then
  logger -p daemon.err -t bb-kiosk-health "$failure"
  node /opt/bb-kiosk-api/ops/notify-telegram.mjs alert health "$failure" >/dev/null 2>&1 || true
  if test -n "${ALERT_WEBHOOK_URL:-}"; then
    payload="$(BB_KIOSK_ALERT_MESSAGE="$failure" BB_KIOSK_ALERT_HOST="$(hostname)" node -e 'process.stdout.write(JSON.stringify({service:"bb-kiosk",status:"error",message:process.env.BB_KIOSK_ALERT_MESSAGE,host:process.env.BB_KIOSK_ALERT_HOST,time:new Date().toISOString()}))')"
    curl --silent --show-error --max-time 10 -H 'Content-Type: application/json' -d "$payload" "$ALERT_WEBHOOK_URL" >/dev/null || true
  fi
  echo "$failure" >&2
  exit 1
fi

logger -p daemon.info -t bb-kiosk-health "ready; disk=${disk_percent}%"
node /opt/bb-kiosk-api/ops/notify-telegram.mjs recover health "API, база данных и интеграция снова доступны" >/dev/null 2>&1 || true
