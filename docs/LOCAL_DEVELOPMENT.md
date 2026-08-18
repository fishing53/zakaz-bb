# Локальная разработка

- Статус: актуально
- Последняя сверка: 18 августа 2026 года

## Требования

- Node.js 22+ и npm 10+;
- PostgreSQL 16+;
- Google Chrome для локальных Playwright-тестов на macOS;
- JDK 17 и Android SDK только для Android-сборки.

## Установка

```bash
git clone git@gitlab.com:yoles-rests/bb-kiosk.git
cd bb-kiosk
npm ci
```

Не копируйте production `.env`, Firebase Admin JSON или iiko credentials на
рабочую станцию. Для разработки используйте отдельную БД и тестовую конфигурацию.

## PostgreSQL и API

1. Создайте пустую локальную базу и пользователя.
2. Скопируйте шаблон окружения:

```bash
cp .env.example .env
```

3. Заполните обязательные значения из [CONFIGURATION.md](CONFIGURATION.md).
4. Примените миграции и запустите API:

```bash
set -a
. ./.env
set +a
node server/migrate.mjs
node server/index.mjs
```

API слушает `127.0.0.1:3107`. Проверка:

```bash
curl -fsS http://127.0.0.1:3107/api/v1/health
curl -fsS http://127.0.0.1:3107/api/v1/health/ready
```

## Клиенты

Киоск:

```bash
npm run dev
```

Приложение официанта:

```bash
npm run build:waiter
npx vite preview --config waiter/vite.config.ts
```

Клиенты используют same-origin `/api`. Vite dev server не проксирует API
автоматически: для полноценной ручной проверки нужен локальный reverse proxy либо
тестовое окружение с тем же origin. UI-разработку без API покрывают Playwright
route mocks.

## Демо-режим

Демо-режим включается для конкретного терминала в админке. Он использует локальное
демо-меню, не отправляет заказ в iiko и автоматически меняет статусы. Не включайте
его на рабочем планшете во время обслуживания гостей.

## Типовой цикл изменения

```bash
npm run check
npm test
npm run build
npm run test:e2e
```

При изменении waiter дополнительно выполните `npm run build:waiter`. При изменении
нативного слоя — `npm run android:debug`.

## Частые проблемы

- `ECONNREFUSED 5432`: PostgreSQL не запущен или неверен `DATABASE_URL`.
- Ошибка обязательных переменных: не заданы `TOKEN_SECRET`,
  `ADMIN_PASSWORD_HASH` или 64 hex-символа `IIKO_CONFIG_ENCRYPTION_KEY`.
- `readiness` возвращает 503: база доступна, но нет актуального снимка меню либо
  активен backoff iiko.
- UI открывается, а API-запросы дают 404: отсутствует same-origin reverse proxy.
- Playwright не находит Chrome на macOS: установите Google Chrome либо измените
  локальную настройку запуска в `playwright.config.ts`.
