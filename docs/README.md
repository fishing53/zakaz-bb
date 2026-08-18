# Документация BB Kiosk

Документы в этой папке описывают текущее поведение кода и production-процессы.
Временные пароли, IP, токены и незавершённые продуктовые идеи здесь не хранятся.

## Разработка

- [Архитектура](ARCHITECTURE.md)
- [Локальная разработка](LOCAL_DEVELOPMENT.md)
- [Конфигурация](CONFIGURATION.md)
- [Тестирование](TESTING.md)
- [Безопасность](SECURITY.md)

## Сборка и эксплуатация

- [Развертывание](DEPLOYMENT.md)
- [Эксплуатация и аварийные действия](OPERATIONS.md)
- [Android и kiosk mode](ANDROID_KIOSK.md)

## Интеграции

- [iiko Cloud API](IIKO_CLOUD_API.md)
- [iikoFront Bridge](../integrations/iiko-front-bridge/README.md)

## Архив

- [Первый перенос в GitLab и на новый сервер](archive/MIGRATION_2026.md)

## Правила обновления

При изменении поведения API, переменной окружения, CI job или operational script
соответствующий документ обновляется в том же merge request. Для постоянных
документов указываются статус и дата последней сверки с кодом. Выполненные планы
переносятся в `archive/`, а не остаются как текущая инструкция.
