#!/usr/bin/env bash
set -euo pipefail

env_file="/etc/bb-kiosk-api.env"
api_dir="/opt/bb-kiosk-api"
health_url="http://127.0.0.1:3107/api/v1/health/ready"

if ! grep -q '^IIKO_CONFIG_ENCRYPTION_KEY=' "$env_file"; then
  config_key="$(openssl rand -hex 32)"
  printf '\nIIKO_CONFIG_ENCRYPTION_KEY=%s\n' "$config_key" >> "$env_file"
  unset config_key
fi
chmod 600 "$env_file"

# iikoFront Bridge keeps one outbound WebSocket open. Update the active site
# once without replacing Certbot-managed TLS settings or symlinks.
nginx_changed=false
while IFS= read -r enabled_site; do
  site_config="$(readlink -f "$enabled_site")"
  if grep -q 'server_name order.brooklynbowl.ru' "$site_config" \
    && grep -q 'proxy_pass http://127.0.0.1:3107' "$site_config" \
    && ! grep -q 'proxy_set_header Upgrade' "$site_config"; then
    sed -i '/proxy_http_version 1.1;/a\        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";' "$site_config"
    sed -i 's/proxy_read_timeout 20s;/proxy_read_timeout 75s;/' "$site_config"
    nginx_changed=true
  fi
done < <(find /etc/nginx/sites-enabled -maxdepth 1 \( -type f -o -type l \) -print)
if "$nginx_changed"; then nginx -t; systemctl reload nginx; fi

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

cd "$api_dir"
node_major="$(node -p 'process.versions.node.split(`.`)[0]')"
if (( node_major < 22 )); then
  echo "BrooklynBowl API requires Node.js 22 or newer; found $(node --version)" >&2
  exit 1
fi
npm ci --omit=dev --no-audit --no-fund
node --check index.mjs
node migrate.mjs
chmod 755 ops/*.sh
cp ops/bb-kiosk-*.service ops/bb-kiosk-*.timer /etc/systemd/system/
cp server/bb-kiosk-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now bb-kiosk-backup.timer bb-kiosk-health.timer
systemctl enable --now bb-kiosk-api
systemctl restart bb-kiosk-api
systemctl is-active bb-kiosk-api
curl --fail --silent --show-error --retry 8 --retry-connrefused --retry-delay 2 "$health_url" >/dev/null

# The first successful start imports legacy iiko credentials into the encrypted
# database row. Remove their plaintext duplicates from the environment file;
# subsequent starts read only the encrypted configuration.
if test "$(psql "$DATABASE_URL" -Atc "select count(*) from iiko_connection_settings where id='active'")" = 1; then
  sed -i -E '/^(IIKO_APP_ID|IIKO_API_LOGIN|IIKO_CLIENT_SECRET|IIKO_WEBHOOK_TOKEN)=/d' "$env_file"
  chmod 600 "$env_file"
  systemctl restart bb-kiosk-api
  curl --fail --silent --show-error --retry 8 --retry-connrefused --retry-delay 2 "$health_url" >/dev/null
fi
