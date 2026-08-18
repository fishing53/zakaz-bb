# Android-приложения

- Статус: актуально
- Последняя сверка: 18 августа 2026 года

## Идентификаторы

| Приложение | Название | Package ID |
| --- | --- | --- |
| Киоск | BrooklynBowl Kiosk | `ru.zvyak.zakaz` |
| Официант | BrooklynBowl Waiter | `ru.zvyak.brooklynbowl.waiter` |

Package ID киоска исторический, но менять его нельзя без миграции: Android сочтёт
новый ID другим приложением и не установит обновление поверх существующего.

## Сборка киоска

Debug APK:

```bash
npm ci
npm run android:debug
```

Команда выполняет TypeScript/Vite build, `cap sync android` и Gradle
`assembleDebug`. APK находится в `android/app/build/outputs/apk/debug/`.

Release APK должен подписываться постоянным keystore. Пароли и файл keystore
хранятся в protected GitLab Variables и в отдельной зашифрованной резервной копии.
Debug APK не используется для распространения production.

Waiter собирается отдельной конфигурацией из `waiter/`; его Firebase client config
находится в `waiter/google-services.json`. Firebase Admin key в APK не включается.

## Kiosk mode

Приложение всегда включает immersive fullscreen. Полностью запретить выход может
только Android Device Owner с Lock Task allowlist.

Production-порядок:

1. Сбросить выделенный планшет либо зарегистрировать его через используемый MDM.
2. Назначить приложение Device Owner.
3. Добавить `ru.zvyak.zakaz` в Lock Task allowlist.
4. Установить подписанный APK и запустить его.
5. Проверить возврат в полноэкранный режим после перезагрузки.

Для временного теста можно использовать системное закрепление экрана. Это не kiosk
security: пользователь с PIN устройства может выйти.

## OTA

Capacitor Updater работает в ручном режиме. Киоск не скачивает и не применяет OTA
во время гостевого заказа. Проверка и применение запускаются из защищённых
настроек планшета. Waiter показывает доступное обновление пользователю.

OTA может менять web bundle, но не нативный код, AndroidManifest, разрешения,
Capacitor plugin или package ID. Такие изменения требуют нового подписанного APK.

Перед OTA:

- выполнить критичные тесты и обе web-сборки;
- убедиться, что bundle совместим с установленным нативным shell;
- опубликовать манифест только после загрузки архива;
- проверить запуск и `appReady`; при ошибке updater должен вернуться к предыдущей
  рабочей версии.

## Разрешения и push

На Android 13+ waiter должен запросить разрешение уведомлений. Для полноэкранных
сценариев дополнительно проверяются настройки уведомлений производителя, режим
энергосбережения и право показа поверх lock screen. FCM-токен регистрируется в API
после входа официанта.

## Диагностика

```bash
adb logcat | grep -i -E 'Capacitor|Updater|Firebase|Brooklyn'
adb shell dumpsys device_policy
adb shell dumpsys activity activities
```

Если web обновился, а приложение показывает старую версию, проверьте OTA manifest,
доступность архива, версию в настройках планшета и журнал Capacitor Updater. Не
очищайте данные приложения до сохранения terminal ID и проверки привязки стола.
