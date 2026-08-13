#!/usr/bin/env bash
set -euo pipefail

env_file="/etc/zakaz-api.env"
api_dir="/opt/zakaz-api"
health_url="http://127.0.0.1:3107/api/v1/health/ready"

if ! grep -q '^IIKO_CONFIG_ENCRYPTION_KEY=' "$env_file"; then
  config_key="$(openssl rand -hex 32)"
  printf '\nIIKO_CONFIG_ENCRYPTION_KEY=%s\n' "$config_key" >> "$env_file"
  unset config_key
fi
chmod 600 "$env_file"

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

cd "$api_dir"
node --check index.mjs
node migrate.mjs
chmod 755 ops/*.sh
cp ops/zakaz-*.service ops/zakaz-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now zakaz-backup.timer zakaz-health.timer
systemctl restart zakaz-api
systemctl is-active zakaz-api
curl --fail --silent --show-error --retry 8 --retry-connrefused --retry-delay 2 "$health_url" >/dev/null

# The first successful start imports legacy iiko credentials into the encrypted
# database row. Remove their plaintext duplicates from the environment file;
# subsequent starts read only the encrypted configuration.
if test "$(psql "$DATABASE_URL" -Atc "select count(*) from iiko_connection_settings where id='active'")" = 1; then
  sed -i -E '/^(IIKO_APP_ID|IIKO_API_LOGIN|IIKO_CLIENT_SECRET|IIKO_WEBHOOK_TOKEN)=/d' "$env_file"
  chmod 600 "$env_file"
  systemctl restart zakaz-api
  curl --fail --silent --show-error --retry 8 --retry-connrefused --retry-delay 2 "$health_url" >/dev/null
fi
