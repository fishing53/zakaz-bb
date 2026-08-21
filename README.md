# BB Kiosk

Монорепозиторий платформы ресторанного самообслуживания BB Kiosk. В проект входят
гостевой киоск, приложение официанта, серверный API, Android-оболочки и локальный
bridge для iikoFront.

Основной репозиторий: <https://gitlab.com/yoles-rests/bb-kiosk>

## Архитектура

```text
Kiosk SPA / Waiter SPA / Android
                 │
                 ▼
          Node.js REST + WSS API
            │             │
            ▼             ▼
       PostgreSQL      iiko Cloud API
                            ▲
                            │ WSS
                     iikoFront Bridge
```

Сервер является доверенной границей системы: секреты iiko и Firebase не
передаются клиентам, а состав и стоимость заказа проверяются повторно перед
отправкой в iiko.

## Стек

| Компонент | Технологии |
| --- | --- |
| Киоск | TypeScript, Vite, HTML, CSS |
| Приложение официанта | TypeScript, Vite, Firebase Cloud Messaging |
| Android | Capacitor 8, Kotlin/Java, Gradle |
| API | Node.js 22, PostgreSQL, WebSocket |
| Интеграция iiko | iiko Cloud API, C#/.NET Framework 4.7.2, iikoFront API V8 |
| Тестирование | Node Test Runner, Playwright |
| Production | Nginx, systemd, PostgreSQL, GitLab CI/CD |

## Структура репозитория

```text
android/                       Android-проект гостевого киоска
deploy/                        Конфигурации Nginx
docs/                          Эксплуатационная документация
integrations/iiko-front-bridge iikoFront bridge-плагин
ops/                           Скрипты деплоя, backup и health-check
public/                        Статические ресурсы киоска
scripts/                       Сборочные и служебные скрипты
server/                        API, миграции и systemd unit
src/                           Клиент гостевого киоска
tests/                         Серверные и интеграционные тесты
waiter/                        Web/Android-клиент официанта
```

## Требования

- Node.js 22 или новее;
- npm 10 или новее;
- PostgreSQL 16 или новее для запуска API;
- JDK 17 и Android SDK для сборки APK;
- .NET SDK 8 для сборки bridge-плагина; локальный установочный сценарий также
  доступен через PowerShell на Windows.

## Установка

```bash
git clone git@gitlab.com:yoles-rests/bb-kiosk.git
cd bb-kiosk
npm ci
```

Запуск клиентского приложения:

```bash
npm run dev
```

Vite выводит локальный адрес после запуска. Клиент использует same-origin API;
для полной локальной среды необходимо отдельно запустить сервер и PostgreSQL.

## Настройка API

Создайте локальный файл окружения на основе `.env.example`. Не добавляйте его в
Git.

```bash
cp .env.example .env
```

Обязательные переменные:

| Переменная | Назначение |
| --- | --- |
| `DATABASE_URL` | Строка подключения PostgreSQL |
| `TOKEN_SECRET` | Подпись сессий, QR-кодов и служебных токенов |
| `PUBLIC_APP_URL` | Публичный HTTPS-адрес установки |
| `ADMIN_PASSWORD_HASH` | SHA-256-хеш пароля администратора |
| `IIKO_CONFIG_ENCRYPTION_KEY` | 32-байтовый ключ AES в hex для секретов интеграции |

Дополнительные серверные параметры, включая Firebase и iiko webhook, описаны в
[руководстве по эксплуатации](docs/OPERATIONS.md).

Для запуска API экспортируйте переменные окружения, примените миграции и запустите
процесс:

```bash
set -a
. ./.env
set +a
node server/migrate.mjs
node server/index.mjs
```

## Команды разработки

| Команда | Назначение |
| --- | --- |
| `npm run dev` | Запустить киоск через Vite |
| `npm run check` | Проверить TypeScript |
| `npm test` | Запустить серверные тесты |
| `npm run test:critical` | TypeScript и серверные тесты |
| `npm run test:e2e` | Запустить Playwright |
| `npm run test:load` | Запустить нагрузочный сценарий |
| `npm run build` | Собрать production-версию киоска |
| `npm run build:waiter` | Собрать web-клиент официанта |
| `npm run sync:images` | Синхронизировать изображения меню |

## Android

Debug-сборка киоска:

```bash
npm run android:debug
```

Команда собирает web-клиент, синхронизирует Capacitor и запускает Gradle. Детали
настройки полноэкранного и Lock Task режимов приведены в
[документации Android](docs/ANDROID_KIOSK.md).

## iikoFront Bridge

Bridge синхронизирует сотрудников и проверяет PIN средствами iikoFront, не
сохраняя PIN на сервере. Для production-сборки требуется выданный iiko Module ID.
Инструкция по сборке, установке и сопряжению находится в
[README интеграции](integrations/iiko-front-bridge/README.md).

## Проверка перед merge

Минимальный набор локальных проверок:

```bash
npm run check
npm test
npm run build
npm run build:waiter
```

Изменения пользовательских сценариев дополнительно проверяются через
`npm run test:e2e`.

## CI/CD

GitLab pipeline определён в `.gitlab-ci.yml` и включает:

- TypeScript, dependency audit и secret scan;
- серверные и браузерные тесты;
- сборку киоска и приложения официанта;
- ручную сборку Android APK;
- ручную сборку iikoFront bridge в .NET SDK-контейнере;
- упаковку OTA-релизов;
- ручной production deploy из основной ветки.

Секреты деплоя хранятся только в защищённых GitLab CI/CD Variables. Production
deploy использует `resource_group`, поэтому параллельные выкладки исключены.

## Production

Публичный адрес установки: <https://order.brooklynbowl.ru>

PWA официанта для iPhone: <https://order.brooklynbowl.ru/waiter/>

Стандартное размещение:

```text
/opt/bb-kiosk-api              API
/var/www/bb-kiosk             web-клиенты киоска и официанта, uploads и OTA
/etc/bb-kiosk-api.env         серверные переменные окружения
/etc/bb-kiosk-waiter-firebase.json
```

API работает как `bb-kiosk-api.service`; backup и health-check запускаются
systemd timers. Порядок развертывания, отката и проверки описан в
[OPERATIONS.md](docs/OPERATIONS.md) и [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Безопасность

- Не коммитьте `.env`, service-account JSON, приватные ключи, дампы БД и токены.
- Не передавайте секреты API в `VITE_*`: такие значения попадают в клиентский
  bundle.
- Не меняйте `TOKEN_SECRET` или `IIKO_CONFIG_ENCRYPTION_KEY` без отдельного плана
  миграции.
- Любой случайно опубликованный секрет необходимо немедленно отозвать и заменить.
- Production-операции выполняются только по HTTPS и с минимально необходимыми
  правами.

## Документация

- [iiko Cloud API](docs/IIKO_CLOUD_API.md)
- [Android kiosk mode](docs/ANDROID_KIOSK.md)
- [Эксплуатация и мониторинг](docs/OPERATIONS.md)
- [Развертывание](docs/DEPLOYMENT.md)
- [Архитектура](docs/ARCHITECTURE.md)
- [Локальная разработка](docs/LOCAL_DEVELOPMENT.md)
- [Конфигурация](docs/CONFIGURATION.md)
- [Тестирование](docs/TESTING.md)
- [Безопасность](docs/SECURITY.md)

## Доступ

Проект предназначен для внутренней разработки. Доступ к репозиторию,
инфраструктуре и production-секретам выдаётся владельцем проекта по принципу
минимально необходимых прав.
