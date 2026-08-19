# Интеграция с iiko Cloud API

- Статус: production implementation
- Проверено с iikoOffice/iikoFront 9.4. Локальный Bridge использует стабильную
  LTS-версию iikoFront API V8; V9 требует iikoRMS 9.5 или новее.
- Последняя сверка с кодом: 18 августа 2026 года

Документ описывает особенности реализации BB Kiosk. Полный контракт и актуальные
поля проверяйте в [официальной документации iiko](https://public-api.iikoweb.ru/portal/documentation).
Секреты в этот файл не добавляются.

## Ответственность интеграции

| Сценарий | Реализация |
| --- | --- |
| Авторизация | Cloud API v2, Bearer token кешируется 14 минут |
| Меню | `/api/2/menu` и `/api/2/menu/by_id` |
| Столы | `/api/1/reserve/available_restaurant_sections` |
| Тип заказа | `/api/1/deliveries/order_types`, сервис `Common` |
| Стоп-лист | `/api/1/stop_lists`, webhook и резервный серверный sync |
| Заказ за столом | `/api/1/order/create` с `tableIds` |
| Статус | `TableOrderUpdate` и `/api/1/order/by_id` как server fallback |
| Ошибки | `TableOrderError`, command correlation ID и monitoring events |

Клиенты не получают iiko credentials и не обращаются к Cloud API. Они используют
только BB Kiosk API и снимки PostgreSQL.

## Настройка в iiko

1. В iikoWeb создайте активный Cloud API login и подключите нужную точку.
2. Назначьте права на меню, заказы, столы, webhook и стоп-лист.
3. Создайте внешний источник заказа `BrooklynBowl Kiosk`.
4. Создайте и вручную сформируйте структуру внешнего меню для той же точки.
5. В developer portal создайте server-to-server приложение категории «Кассы и
   зал» и получите App ID/Client Secret.
6. Для кухонных статусов настройте места приготовления и кухонный экран iikoFront.

Module ID не относится к Cloud API; он требуется только iikoFront Bridge.

## Мастер подключения BB Kiosk

В админке откройте «Проверка iiko» → «Настройки подключения». Введите App ID, API
Login и Client Secret. Сервер получает организации, терминальные группы, внешние
меню и типы заказов. При нескольких вариантах администратор выбирает их по имени.

Перед применением сервер проверяет авторизацию, terminal group, меню, столы, тип
заказа и стоп-лист. Затем создаёт webhook token, регистрирует callback
`${PUBLIC_APP_URL}/api/v1/iiko/webhook` и перечитывает настройки. При ошибке
возвращается предыдущая рабочая конфигурация.

Секреты шифруются AES-256-GCM через `IIKO_CONFIG_ENCRYPTION_KEY`. Пустое секретное
поле в форме означает «сохранить прежнее значение»; API не возвращает исходный
секрет браузеру.

## Авторизация

```http
POST https://api-ru.iiko.services/api/v2/access_token
Content-Type: application/json

{
  "appId": "<app-id>",
  "apiLogin": "<api-login>",
  "clientSecret": "<client-secret>"
}
```

Дальнейшие запросы содержат `Authorization: Bearer <token>`. Не запрашивайте токен
для каждой операции.

## Справочники

Последовательность discovery:

```text
POST /api/1/organizations
POST /api/1/terminal_groups
POST /api/1/terminal_groups/is_alive
POST /api/2/menu
POST /api/1/deliveries/order_types
POST /api/1/reserve/available_restaurant_sections
```

В заказ передаётся UUID стола iiko, а не отображаемый номер. Для зала используется
order type с `orderServiceType: Common`.

## Меню

```http
POST /api/2/menu/by_id

{
  "externalMenuId": "<menu-id>",
  "organizationIds": ["<organization-id>"],
  "version": 2,
  "language": "ru",
  "asyncMode": false
}
```

BB Kiosk сохраняет категории, названия, описание, цену, вес, nutrition, аллергены,
изображение iiko и modifier groups. Локальная presentation по SKU может заменить
фото, кадрирование, бейдж, состав и рекомендации.

Обновление номенклатуры RMS не гарантирует автоматическое добавление позиции в
структуру внешнего меню. Новое блюдо необходимо включить в нужную группу внешнего
меню и опубликовать его в iiko.

## Стоп-лист

```http
POST /api/1/stop_lists

{
  "organizationIds": ["<organization-id>"],
  "terminalGroupsIds": ["<terminal-group-id>"],
  "returnSize": true
}
```

`balance <= 0` блокирует позицию. При полном новом снимке сервер сначала удаляет
предыдущие строки группы, поэтому снятая со стоп-листа позиция снова становится
доступной. `StopListUpdate` запускает асинхронное получение полного снимка; webhook
получает быстрый `200`, чтобы iiko не создавала повторный burst.

Административный endpoint ручной проверки защищён и не вызывается при рендере:
`GET /api/v1/iiko/stop-list`.

## Создание заказа

Ключевые поля payload:

```json
{
  "organizationId": "<organization-id>",
  "terminalGroupId": "<terminal-group-id>",
  "order": {
    "id": "<deterministic-uuid>",
    "externalNumber": "BB-...",
    "tableIds": ["<table-id>"],
    "guests": { "count": 1 },
    "menuId": "<external-menu-id>",
    "orderTypeId": "<common-order-type-id>",
    "sourceKey": "BrooklynBowl Kiosk",
    "items": []
  },
  "createOrderSettings": {
    "servicePrint": true,
    "transportToFrontTimeout": 30,
    "checkStopList": true
  }
}
```

До отправки сервер пересчитывает цену и проверяет стол, товары, количество,
модификаторы и стоп-лист. UUID строится из restaurant ID и client request ID.
Асинхронный ответ `InProgress` ожидается через webhook/command status; correlation
ID сохраняется для диагностики.

`servicePrint: true` отправляет позиции на настроенные места приготовления. Smoke
test использует `false` и специальный source key.

## Статусы

| iiko item status | Шаг BB Kiosk |
| --- | --- |
| `Added` | принят |
| `PrintedNotCooking` | передан на кухню |
| `CookingStarted` | готовится |
| `CookingCompleted` | готов |
| `Served` или закрытый заказ | подан |

Смешанные позиции агрегируются без движения назад. Webhook сохраняется в
`iiko_webhook_events`, снимок — в `iiko_orders`, история — отдельно. Клиентский
`GET /api/v1/iiko/orders/<id>/status` читает PostgreSQL и не вызывает iiko.

## Webhook

```text
POST ${PUBLIC_APP_URL}/api/v1/iiko/webhook
Authorization: Bearer <generated-token>
```

Подписки: `TableOrderUpdate`, `TableOrderError`, `StopListUpdate`. Максимум 100
событий в одном payload. Неизвестные типы игнорируются. Token генерируется сервером
и сверяется до записи события.

Регистрация выполняется через `/api/1/webhooks/update_settings`, проверка — через
`/api/1/webhooks/settings`. Не обновляйте настройки на каждом health-check.

## Rate limit и синхронизация

- webhook — основной источник изменений;
- общий menu/table/stop-list sync — раз в 10 минут;
- stop-list fallback — раз в 2 минуты;
- активные заказы сверяются сервером раз в 2 минуты, максимум 30 заказов младше
  восьми часов;
- access token кешируется;
- `429` включает общий backoff с учётом `Retry-After`;
- параллельный общий sync не запускается;
- планшеты не выполняют polling iiko.

## Диагностика

```bash
curl -fsS https://order.brooklynbowl.ru/api/v1/health/ready
journalctl -u bb-kiosk-api.service -n 200 --no-pager
```

Для заказа используйте correlation ID и таблицы `customer_orders`, `iiko_orders`,
`order_status_history`, `iiko_webhook_events`, `monitoring_events`. Для стоп-листа
проверьте `iiko_stop_list_items` по organization и terminal group.

## Официальные источники

- [iiko Developer Portal](https://public-api.iikoweb.ru/portal/documentation)
- [iiko Cloud API](https://api-ru.iiko.services/docs)
- [iikoFront API](https://iiko.github.io/front.api.doc/)
