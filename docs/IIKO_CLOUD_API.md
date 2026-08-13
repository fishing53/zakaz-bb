# Интеграция BrooklynBowl Kiosk с iiko Cloud API

Этот документ описывает фактически настроенную интеграцию с iiko для BrooklynBowl Kiosk: получение внешнего меню, столов и стоп-листа, создание заказов за столом и статусы приготовления.

Документ предназначен для разработки и эксплуатации. Не помещайте в него API-ключи, Client Secret, токены webhook или пароли.

## Что уже настроено

| Сценарий | Статус | Как работает |
| --- | --- | --- |
| Авторизация iiko Cloud API v2 | Проверено | Сервер получает Bearer-токен и кеширует его 14 минут |
| Внешнее меню | Проверено | Получение категорий, блюд и цен из внешнего меню iiko |
| Залы и столы | Проверено | Получение доступных столов терминальной группы |
| Заказ за столом | Проверено | Создание заказа с `tableIds` и типом `Common` |
| Статусы кухни | Проверено | `TableOrderUpdate` приходит на наш webhook |
| Стоп-лист | Проверено вручную | `/api/1/stop_lists` возвращает недоступные блюда; автоматическая подписка на `StopListUpdate` должна быть включена после снятия rate limit |

Текущий API используется только сервером. Планшеты **никогда не должны обращаться к iiko напрямую**: они запрашивают данные у нашего Node.js API, а он хранит и кеширует результат в PostgreSQL.

## Где что настраивается в iiko

### iikoWeb: Cloud API login

Раздел: **Внешние заказы → Настройки Cloud API**.

Для API-логина BrooklynBowl Kiosk должны быть заданы:

- интеграция активна;
- подключена рабочая точка ресторана;
- шаблон прав, включающий работу с меню, заказами, столами, webhook и стоп-листом;
- источник заказа: `BrooklynBowl Kiosk`.

API-ключ, показанный в карточке API-логина, — это значение `IIKO_API_LOGIN`. Это не название логина.

### Портал разработчика iiko

Раздел: [Портал разработчика](https://public-api.iikoweb.ru/portal/).

Создано приложение типа `server-to-server`, категория «Кассы и зал». Из него берутся:

- `App ID` → `IIKO_APP_ID`;
- `Client Secret` → `IIKO_CLIENT_SECRET`.

`Module ID` для Cloud API не нужен. Он относится к локальным плагинам iikoFront API.

### Внешнее меню

Раздел: **Внешние заказы → Внешнее меню**.

Меню должно быть создано для той же точки, что подключена к API-логину. Его ID и версия возвращаются запросом `/api/2/menu` и используются в `/api/2/menu/by_id`.

### Кухонный экран

Чтобы iiko реально меняла статусы приготовления, недостаточно отправить заказ на печать. В iikoOffice в настройках нужного отделения включите **«Показывать блюда на кухонном экране»**, настройте статусы и привяжите место приготовления к блюду. Затем перезапустите iikoFront.

## Конфигурация сервера

Системные секреты находятся в `/etc/zakaz-api.env` на production-сервере. Минимальный набор:

```env
DATABASE_URL=postgres://...
TOKEN_SECRET=<длинный случайный секрет>
ADMIN_PASSWORD_HASH=<sha256 хеш пароля админки>
IIKO_CONFIG_ENCRYPTION_KEY=<32 байта в hex, не менять после создания>

```

Данные подключения iiko вводятся в веб-админке → «Проверка iiko» → «Настройки подключения iiko». Вручную нужны только `App ID`, `API Login` и `Client Secret`. Сервер через Cloud API получает доступные организации, терминальные группы, внешние меню и типы заказов; администратор выбирает варианты по названию, не работая с UUID. Российский адрес Cloud API, источник заказа и webhook-токен устанавливаются автоматически.

App ID, API Login, Client Secret и Webhook Token сохраняются в PostgreSQL только в зашифрованном виде. Переменные `IIKO_APP_ID`, `IIKO_API_LOGIN`, `IIKO_CLIENT_SECRET` и `IIKO_WEBHOOK_TOKEN` нужны лишь для первичного переноса старой установки и автоматически удаляются из env после успешного импорта.

После нажатия «Сохранить и применить» сервер без перезапуска проверяет подключение, обновляет меню, столы и стоп-лист. При ошибке он автоматически возвращает предыдущую рабочую конфигурацию.

Сервис запущен от пользователя `www-data`, рабочий каталог production — `/opt/zakaz-api`.

## Авторизация

Все запросы выполняются к:

```text
https://api-ru.iiko.services
```

Получение токена:

```http
POST /api/v2/access_token
Content-Type: application/json

{
  "appId": "<IIKO_APP_ID>",
  "apiLogin": "<IIKO_API_LOGIN>",
  "clientSecret": "<IIKO_CLIENT_SECRET>"
}
```

Ответ содержит `token`. Далее он передаётся как:

```http
Authorization: Bearer <token>
```

В `server/index.mjs` токен кешируется в памяти на 14 минут. Не получайте новый токен для каждого запроса.

## Проверенные запросы Cloud API

Во всех примерах ниже к запросу добавляется `Authorization: Bearer <token>` и `Content-Type: application/json`.

### Организации

```http
POST /api/1/organizations
{}
```

Возвращает доступные организации. `id` нужной организации нужно сохранить как `IIKO_ORGANIZATION_ID`.

### Терминальные группы

```http
POST /api/1/terminal_groups
{
  "organizationIds": ["<organization-id>"]
}
```

Нужен `terminalGroupId` группы, через которую будут создаваться заказы.

Проверка доступности Front:

```http
POST /api/1/terminal_groups/is_alive
{
  "terminalGroupIds": ["<terminal-group-id>"]
}
```

Перед созданием заказа терминальная группа должна возвращаться с `isAlive: true`.

### Залы и столы

```http
POST /api/1/reserve/available_restaurant_sections
{
  "terminalGroupIds": ["<terminal-group-id>"],
  "returnSchema": true
}
```

Из ответа используются `restaurantSection.id`, `tables.id`, номер и название стола. Для заказа передаётся именно UUID из `tables.id`, а не текстовый номер стола.

### Типы заказов

Правильный endpoint:

```http
POST /api/1/deliveries/order_types
{
  "organizationIds": ["<organization-id>"]
}
```

Для заказа в зале выбирается тип с `orderServiceType: "Common"`, например «Обычный заказ».

Важно: путь `/api/1/order_types` неверный и приводит к ложной ошибке доступа.

### Внешнее меню

Список внешних меню:

```http
POST /api/2/menu
{
  "organizationIds": ["<organization-id>"]
}
```

Детали меню:

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

Из ответа берутся категории, позиции, цены, ID блюд и модификаторы. ID блюда из iiko становится `productId` при создании заказа.

### Стоп-лист

```http
POST /api/1/stop_lists
{
  "organizationIds": ["<organization-id>"],
  "terminalGroupsIds": ["<terminal-group-id>"],
  "returnSize": true
}
```

Каждая позиция содержит `productId` и `balance`.

- `balance: 0` — блюдо отсутствует;
- положительное значение — доступно только указанное количество;
- наличие записи означает, что позиция должна учитываться при выборе блюда.

Наш сервер сохраняет результат в `iiko_stop_list_items`. Временный ручной endpoint для проверки:

```text
GET /api/v1/iiko/stop-list?terminalGroupId=<terminal-group-id>
```

Этот endpoint выполняет запрос к iiko, поэтому не вызывайте его из интерфейса на каждом рендере. В пользовательском API приложение должно получать уже сохранённую доступность из нашей базы.

### Создание заказа за столом

```http
POST /api/1/order/create
{
  "organizationId": "<organization-id>",
  "terminalGroupId": "<terminal-group-id>",
  "order": {
    "id": "<новый UUID>",
    "externalNumber": "BB-<уникальный номер>",
    "tableIds": ["<table-id>"],
    "guests": { "count": 1 },
    "menuId": "<external-menu-id>",
    "orderTypeId": "<Common order type ID>",
    "sourceKey": "BrooklynBowl Kiosk",
    "items": [
      {
        "type": "Product",
        "productId": "<iiko product ID>",
        "amount": 1,
        "price": 59,
        "comment": ""
      }
    ]
  },
  "createOrderSettings": {
    "servicePrint": true,
    "transportToFrontTimeout": 30,
    "checkStopList": true
  }
}
```

`servicePrint: true` отправляет позиции на кухню/бар согласно настройкам iiko. API сначала может вернуть `creationStatus: "InProgress"` — это нормальное асинхронное выполнение.

Проверка команды:

```http
POST /api/1/commands/status
{
  "organizationId": "<organization-id>",
  "correlationId": "<correlation-id из create>"
}
```

Финальное состояние должно быть `Success`. Сохраняйте `orderInfo.id` как iiko Order ID, а `orderInfo.posId` как идентификатор заказа в iikoFront. В таблице `customer_orders` для этого есть поля `iiko_order_id` и `iiko_pos_id`.

### Чтение заказа и статуса

```http
POST /api/1/order/by_id
{
  "organizationIds": ["<organization-id>"],
  "orderIds": ["<iiko-order-id>"]
}
```

Заказы по столу:

```http
POST /api/1/order/by_table
{
  "organizationIds": ["<organization-id>"],
  "tableIds": ["<table-id>"]
}
```

## Статусы приготовления

iiko отдаёт статус каждой позиции, а не только заказа:

| Статус iiko | Значение | Шаг интерфейса |
| --- | --- | --- |
| `Added` | Добавлено, не отправлено на кухню | 0 — заказ принят |
| `PrintedNotCooking` | Напечатано на кухне | 1 — отправлен на кухню |
| `CookingStarted` | Готовится | 2 — готовится |
| `CookingCompleted` | Готово | 3 — заказ готов |
| `Served` | Подано | 4 — подан |

Возможен переход сразу из `CookingStarted` в `Served`; интерфейс должен принимать такие скачки без ошибки.

В нашем сервере webhook сохраняется в `iiko_webhook_events`, актуальное агрегированное состояние — в `iiko_orders`. Проверочный endpoint:

```text
GET /api/v1/iiko/orders/<iiko-order-id>/status
```

Он возвращает `statusStep`, общий статус и статусы всех позиций.

## Webhook-и

### Адрес обработчика

Production webhook:

```text
POST https://заказ.звяк.рф/api/v1/iiko/webhook
```

Адрес должен быть публичным, доступным по HTTPS и отвечать `200` после успешной обработки.

### Защита

В iiko при настройке передаётся `authToken`, равный `IIKO_WEBHOOK_TOKEN`. Сервер принимает его в заголовке `Authorization` в одном из форматов:

```text
Authorization: <IIKO_WEBHOOK_TOKEN>
Authorization: Bearer <IIKO_WEBHOOK_TOKEN>
```

Не используйте webhook без токена и не передавайте этот токен в клиентское приложение.

### Регистрация webhook через Cloud API

```http
POST /api/1/webhooks/update_settings
{
  "organizationId": "<organization-id>",
  "webHooksUri": "https://заказ.звяк.рф/api/v1/iiko/webhook",
  "authToken": "<IIKO_WEBHOOK_TOKEN>",
  "webHooksFilter": {
    "tableOrderFilter": {
      "orderStatuses": ["New", "Bill", "Closed", "Deleted"],
      "itemStatuses": [
        "Added",
        "PrintedNotCooking",
        "CookingStarted",
        "CookingCompleted",
        "Served"
      ],
      "errors": true
    },
    "stopListUpdateFilter": {
      "updates": true
    }
  }
}
```

Проверка текущих настроек:

```http
POST /api/1/webhooks/settings
{
  "organizationId": "<organization-id>"
}
```

События приходят массивом JSON-объектов. Уже обрабатываются:

- `TableOrderUpdate`;
- `TableOrderError`;
- `StopListUpdate`.

При `StopListUpdate` событие содержит только список изменившихся терминальных групп. Сервер должен запросить полный актуальный стоп-лист через `/api/1/stop_lists`, затем заменить сохранённый снимок этой группы.

## Rate limit: обязательные правила

iiko ограничивает число запросов. Ошибка `429 Too many requests within allowed period of time` уже наблюдалась при серии ручных проверок.

Правила для production:

1. Никогда не вызывать Cloud API из браузера или Android-приложения.
2. Webhook — основной источник изменений, polling — только резервный.
3. Не обновлять webhook-настройки повторно без необходимости.
4. Кешировать access token, меню, стоп-лист и справочники.
5. При `429` учитывать `Retry-After` и применять экспоненциальную задержку; не делать повторную попытку сразу.
6. Резервную проверку активных заказов выполнять серверным пакетным запросом раз в 2–3 минуты, а не по одному запросу от каждого планшета.
7. Стоп-лист синхронизировать через webhook; без webhook — не чаще одного раза в 10–15 минут.

Текущий endpoint `GET /api/v1/iiko/orders/<id>/status` имеет тестовый fallback: если сохранённый статус старше 15 секунд, он читает заказ из iiko. **Не подключайте его к периодическому опросу клиентом.** Перед массовым подключением планшетов этот fallback должен быть заменён на пакетную серверную фоновую синхронизацию.

## База данных

| Таблица | Назначение |
| --- | --- |
| `customer_orders` | Заказы приложения; содержит связь `iiko_order_id`, `iiko_pos_id` |
| `iiko_orders` | Актуальные снимки заказов и агрегированный `status_step` |
| `iiko_webhook_events` | Неизменяемый журнал входящих событий iiko |
| `iiko_stop_list_items` | Последний снимок стоп-листа по терминальной группе |

Изменения схемы запускаются командой:

```bash
cd /opt/zakaz-api
set -a && . /etc/zakaz-api.env && set +a
node migrate.mjs
```

## Проверка интеграции

### Быстрый health-check

```bash
curl -fsS https://заказ.звяк.рф/api/v1/health
```

### Логи и сервис

```bash
sudo systemctl status zakaz-api.service
sudo journalctl -u zakaz-api.service -n 100 --no-pager
```

### Тест статуса кухни

1. Создайте тестовый заказ на тестовом столе.
2. В iikoFront нажмите «Печать».
3. На кухонном экране переведите блюдо в «Готовится» или «Приготовлено».
4. Убедитесь, что в `iiko_webhook_events` появился `TableOrderUpdate`.
5. Проверьте `GET /api/v1/iiko/orders/<id>/status`.

### Тест стоп-листа

1. В iikoFront откройте дополнительное меню → «Стоп-лист».
2. Поместите тестовое блюдо в стоп-лист или установите остаток `0`.
3. Вызовите `/api/1/stop_lists` либо дождитесь `StopListUpdate`.
4. Убедитесь, что блюдо появилось в `iiko_stop_list_items`.
5. Верните блюдо из стоп-листа после проверки.

## Что ещё нужно сделать при подключении интерфейса

- сделать отдельную серверную задачу синхронизации с лимитами и backoff;
- хранить сопоставление визуальных данных приложения (фото, КБЖУ, «Идеально с») с `productId` iiko;
- конвертировать локальные соусы и дополнения в модификаторы iiko;
- перед созданием заказа проверять стоп-лист и доступность терминальной группы;
- сохранять ID iiko сразу после успешного `order/create`;
- отдавать планшету состояние только из нашей БД;
- добавить админскую кнопку «Синхронизировать меню/стоп-лист» с защитой от слишком частых запусков.

## Официальные источники

- [Портал разработчика iiko](https://public-api.iikoweb.ru/portal/documentation)
- [Cloud API: Orders](https://api-ru.iiko.services/docs#tag/Orders)
- [Cloud API: Menu](https://api-ru.iiko.services/docs#tag/Menu)
- [Cloud API: Webhooks](https://api-ru.iiko.services/docs#tag/Webhooks)
- [Cloud API: Stop lists](https://api-ru.iiko.services/docs#tag/Dictionaries)
- [Документация iikoFront](https://iiko.github.io/front.api.doc/)
