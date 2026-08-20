# Конфигурация

- Статус: актуально
- Последняя сверка с `server/index.mjs`: 20 августа 2026 года

Секреты production хранятся в `/etc/bb-kiosk-api.env` с правами `0600`. Значения
не должны попадать в Git, Markdown, клиентский bundle или журнал CI.

## Обязательные переменные API

| Переменная | Секрет | Назначение |
| --- | --- | --- |
| `DATABASE_URL` | да | PostgreSQL connection string |
| `TOKEN_SECRET` | да | подпись сессий, QR и служебных токенов |
| `ADMIN_PASSWORD_HASH` | да | SHA-256-хеш bootstrap-пароля администратора |
| `IIKO_CONFIG_ENCRYPTION_KEY` | да | 32 байта в hex для AES-256-GCM |
| `PUBLIC_APP_URL` | нет | канонический публичный HTTPS URL |

Смена `TOKEN_SECRET` инвалидирует активные сессии и QR. Смена
`IIKO_CONFIG_ENCRYPTION_KEY` без предварительной миграции делает сохранённые
настройки iiko и Telegram нечитаемыми.

## Необязательные переменные API

| Переменная | Значение по умолчанию / назначение |
| --- | --- |
| `PORT` | `3107` |
| `TERMINAL_ADMIN_PASSWORD_HASH` | наследует `ADMIN_PASSWORD_HASH` |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | путь к Firebase Admin JSON |
| `IIKO_API_BASE` | `https://api-ru.iiko.services` |
| `IIKO_WEBHOOK_URL` | `${PUBLIC_APP_URL}/api/v1/iiko/webhook` в стандартной установке |
| `IIKO_ORDER_SOURCE_KEY` | `BrooklynBowl Kiosk` |
| `OTA_MANIFEST_PATH` | `/var/www/bb-kiosk/ota/manifest.json` |
| `WAITER_OTA_MANIFEST_PATH` | `/var/www/bb-kiosk/ota/waiter/manifest.json` |
| `APPLICATION_DOWNLOAD_DIR` | `/var/www/bb-kiosk/downloads`; подписанные APK и `manifest.json` для одноразовых выдач |
| `BANNER_UPLOAD_DIR` | `/var/www/bb-kiosk/uploads/banners` |
| `BANNER_PUBLIC_PATH` | `/uploads/banners` |
| `PRODUCT_UPLOAD_DIR` | `/var/www/bb-kiosk/uploads/products` |
| `PRODUCT_PUBLIC_PATH` | `/uploads/products` |
| `BB_KIOSK_BACKUP_DIR` | `/var/backups/bb-kiosk-postgres` |
| `QUALITY_REPORT_PATH` | `/opt/bb-kiosk-api/quality-report.json` |

## Настройки iiko

Рабочие `App ID`, `API Login` и `Client Secret` вводятся в защищённом мастере
админки. Организация, терминальная группа, внешнее меню и тип заказа выбираются из
ответа iiko. Конфигурация шифруется в PostgreSQL.

Переменные `IIKO_APP_ID`, `IIKO_API_LOGIN`, `IIKO_CLIENT_SECRET`,
`IIKO_ORGANIZATION_ID`, `IIKO_TERMINAL_GROUP_ID`, `IIKO_EXTERNAL_MENU_ID`,
`IIKO_ORDER_TYPE_ID` и `IIKO_WEBHOOK_TOKEN` поддерживаются только для переноса
старой установки. Для новой установки не используйте их как постоянный источник.

## Backup и health-check

| Переменная | По умолчанию |
| --- | --- |
| `BB_KIOSK_BACKUP_DIR` | `/var/backups/bb-kiosk-postgres` |
| `BB_KIOSK_BACKUP_RETENTION_DAYS` | `14` |
| `BB_KIOSK_HEALTH_URL` | локальный readiness URL |
| `BB_KIOSK_MAX_DISK_PERCENT` | порог заполнения диска |
| `BB_KIOSK_MAX_MENU_AGE_MINUTES` | допустимый возраст меню |
| `ALERT_WEBHOOK_URL` | дополнительный внешний alert webhook |

Переменные с префиксом `ZAKAZ_` оставлены только для обратной совместимости и не
должны использоваться в новых конфигурациях.

## Тестовые переменные

- `LOAD_TEST_URL`, `LOAD_TEST_CLIENTS`, `LOAD_TEST_REQUESTS`;
- `ALLOW_REMOTE_LOAD_TEST=YES` — обязательное подтверждение удалённой нагрузки;
- `IIKO_SMOKE_CONFIRM` и `IIKO_TEST_*` — только для явно запущенного smoke-теста;
- `BROWSER_TESTS_PASSED` — формирование CI quality report.

## GitLab CI/CD Variables

Не секретные: `PUBLIC_APP_URL`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_WEB_ROOT`,
`DEPLOY_API_ROOT`, `ANDROID_KEY_ALIAS`, `IIKO_LICENSE_MODULE_ID`.

Masked/protected или file variables: `DEPLOY_SSH_PRIVATE_KEY`, `SSH_KNOWN_HOSTS`,
`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`.

Release keystore должен иметь отдельную зашифрованную резервную копию. Его потеря
не позволит обновить уже установленные APK.
