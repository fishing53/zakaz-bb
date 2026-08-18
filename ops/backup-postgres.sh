#!/usr/bin/env bash
set -euo pipefail

trap 'status=$?; node /opt/bb-kiosk-api/ops/notify-telegram.mjs alert backup "Не удалось создать резервную копию PostgreSQL" >/dev/null 2>&1 || true; exit "$status"' ERR

backup_dir="${BB_KIOSK_BACKUP_DIR:-${ZAKAZ_BACKUP_DIR:-/var/backups/bb-kiosk-postgres}}"
retention_days="${BB_KIOSK_BACKUP_RETENTION_DAYS:-${ZAKAZ_BACKUP_RETENTION_DAYS:-14}}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="${backup_dir}/bb-kiosk-${timestamp}.dump"
temporary="${target}.partial"

test -n "${DATABASE_URL:-}" || { echo "DATABASE_URL is not configured" >&2; exit 1; }
install -d -m 700 "$backup_dir"
umask 077
pg_dump --format=custom --compress=9 --no-owner --no-acl "$DATABASE_URL" > "$temporary"
pg_restore --list "$temporary" >/dev/null
mv "$temporary" "$target"
sha256sum "$target" > "${target}.sha256"
find "$backup_dir" -type f \( -name 'bb-kiosk-*.dump' -o -name 'bb-kiosk-*.dump.sha256' \) -mtime "+${retention_days}" -delete
echo "PostgreSQL backup verified: $target"
node /opt/bb-kiosk-api/ops/notify-telegram.mjs recover backup "Резервное копирование PostgreSQL снова работает" >/dev/null 2>&1 || true
