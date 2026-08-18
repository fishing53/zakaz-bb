# Развертывание BB Kiosk

- Статус: актуально
- Последняя сверка с `.gitlab-ci.yml`: 18 августа 2026 года

## Production layout

```text
/opt/bb-kiosk-api/                    API и ops-скрипты
/var/www/bb-kiosk/                    web bundle
/var/www/bb-kiosk/uploads/            изменяемые изображения
/var/www/bb-kiosk/ota/                OTA-манифесты и архивы
/var/backups/bb-kiosk-postgres/       PostgreSQL backup
/etc/bb-kiosk-api.env                 server-only secrets
/etc/bb-kiosk-waiter-firebase.json    Firebase Admin service account
```

Сервисы: `bb-kiosk-api.service`, `bb-kiosk-backup.timer` и
`bb-kiosk-health.timer`. Nginx проксирует API в `127.0.0.1:3107`.

## Предварительные требования

- Ubuntu LTS, Node.js 22+, PostgreSQL 16+, Nginx, rsync и systemd;
- DNS и действующий TLS-сертификат;
- deploy-пользователь с SSH-ключом и ограниченными правами;
- заполненный `/etc/bb-kiosk-api.env`;
- Firebase Admin JSON с минимальными правами;
- внешний backup uploads и PostgreSQL;
- назначенный GitLab Runner.

## GitLab pipeline

`.gitlab-ci.yml` собирает и проверяет артефакты до deploy. Production job запускается
вручную из основной ветки и защищён `resource_group: production`.

Обязательные GitLab Variables перечислены в [CONFIGURATION.md](CONFIGURATION.md).
SSH private key и `known_hosts` передаются как protected file variables; отключать
проверку host key запрещено.

## Порядок релиза

1. Получить зелёные typecheck, test, E2E, build, audit и secret scan.
2. Проверить release notes и совместимость миграций назад.
3. Создать проверенный backup БД и убедиться, что внешний backup доступен.
4. Запустить ручной `deploy_production`.
5. Job синхронизирует web без удаления `uploads/` и `ota/`, публикует OTA,
   доставляет API/ops и запускает `ops/deploy-api.sh`.
6. Скрипт выполняет `npm ci --omit=dev`, миграции, устанавливает systemd units и
   перезапускает API.
7. Проверить readiness и сценарии из раздела ниже.

Deploy API вызывает короткий перезапуск процесса и не является zero-downtime.
Изменение схемы должно оставаться совместимым с предыдущей версией до завершения
rollback window.

## Проверка после релиза

```bash
systemctl is-active bb-kiosk-api
systemctl is-active bb-kiosk-backup.timer
systemctl is-active bb-kiosk-health.timer
curl -fsS https://order.brooklynbowl.ru/api/v1/health
curl -fsS https://order.brooklynbowl.ru/api/v1/health/ready
```

Затем проверить bootstrap, меню, стоп-лист, тестовый заказ, webhook статуса, четыре
вызова официанта, push в фоне, вход в админку, загрузку изображения, QR и ручную
проверку OTA обоих приложений.

## Rollback

1. Остановить новые изменения данных, если проблема затрагивает заказы или БД.
2. Вернуть предыдущие web/OTA-артефакты.
3. Вернуть предыдущий API commit и перезапустить service.
4. Не откатывать PostgreSQL вслепую: сначала определить новые записи после
   релиза и проверить состояние заказов в iiko.
5. Если миграция необратима, восстановить backup только по отдельному плану с
   согласованием потери данных.
6. После восстановления повторить health и smoke-проверки.

## Перенос на новый сервер

Исторический план первого переезда сохранён в
[archive/MIGRATION_2026.md](archive/MIGRATION_2026.md). Он не является инструкцией
ежедневного deploy и не должен выполняться без актуальной проверки окружения.

## GitHub workflows

Legacy workflows в `.github/workflows/` временно сохранены как страховка перехода.
После успешной сборки и deploy через GitLab их необходимо отключить, затем удалить
отдельным изменением. Одновременная автоматическая публикация из GitHub и GitLab
не допускается.
