# Тестирование

- Статус: актуально
- Последняя сверка: 19 августа 2026 года

## Уровни проверок

### Статический анализ

```bash
npm run check
```

Проверяет TypeScript киоска и общих клиентских модулей без генерации файлов.

### Серверные тесты

```bash
npm test
```

Покрыты публикация меню и SKU, стоп-лист, корзина и модификаторы, промокоды,
выбор стола, idempotency, статусы iiko, жизненный цикл вызова официанта, iikoFront
Bridge и контракт с локальным эмулятором iiko.

### Browser E2E

```bash
npm run test:e2e
```

Playwright запускает сценарии на viewport планшета и телефона. Сейчас проверяются
критический гостевой заказ и защищённый раздел безопасности администратора. Внешние
API подменяются route mocks; тест не создаёт заказ в production iiko.

### Сборки

```bash
npm run build
npm run build:waiter
```

Обе команды обязательны при изменении общего UI или иконок.

### Нагрузочная проверка

```bash
LOAD_TEST_URL=http://127.0.0.1:3107 \
LOAD_TEST_CLIENTS=50 \
LOAD_TEST_REQUESTS=10 \
npm run test:load
```

Удалённый запуск дополнительно требует `ALLOW_REMOTE_LOAD_TEST=YES`. Не запускайте
нагрузочный тест против production без согласованного окна.

### Smoke-тест iiko

Запускается только вручную из раздела «Безопасность». Он создаёт реальный заказ с
пометкой `АВТОТЕСТ — НЕ ГОТОВИТЬ`, поэтому заранее согласуйте тестовый стол и после
проверки завершите заказ в iiko.

## Проверка перед merge

```bash
npm run check
npm test
npm run build
npm run build:waiter
npm run test:e2e
```

При изменении Android APK собирается ручной job. Bridge собирается в Linux-
контейнере с выданным Module ID либо с `0` только для проверки компиляции.

## GitLab pipeline

Pipeline выполняет typecheck, dependency audit, gitleaks, серверные тесты,
Playwright, web-сборки, Android APK, OTA-пакеты и при необходимости bridge. Deploy
production остаётся ручным. Job выполняются на защищённом project runner с Docker
executor; одновременно запускается не более одной job. iikoFront Bridge
собирается вручную в .NET SDK-контейнере и не блокирует основной pipeline.

## Известные пробелы

- нет автоматического тестового восстановления реального backup PostgreSQL;
- нет Android instrumentation-тестов Device Owner, push в фоне и OTA apply;
- нет теста миграции со снимка предыдущей production-схемы;
- нет длительного soak-теста фоновой синхронизации iiko;
- E2E не проверяет настоящий iiko Cloud API и Firebase.

Эти проверки выполняются вручную перед крупным релизом до появления отдельных
стендов и runners.
