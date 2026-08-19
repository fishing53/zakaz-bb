# BrooklynBowl iikoFront Bridge

Локальный плагин для iikoFront 9.4. Он синхронизирует сотрудников с сервером BB Kiosk и проверяет PIN внутри iikoFront. PIN не сохраняется ни в плагине, ни на сервере.

Плагин использует стабильную LTS-версию iikoFront API V8. Это правильная версия
для iikoFront 9.4: стабильная V9 доступна начиная с iikoRMS 9.5, а V8
поддерживается до iikoRMS 10.3 включительно.

## Сборка

Требуются Windows, .NET SDK, выданный iiko `Module ID` и постоянный strong-name
ключ разработчика:

```powershell
.\build.ps1 -ModuleId ВАШ_MODULE_ID -SigningKeyFile C:\secure\developer.snk -BindingFile C:\secure\binding.jwt
```

Готовый ZIP появится в `artifacts`. В GitLab сборка описана ручной задачей
`build_iiko_front_plugin`; для рабочей сборки задайте CI/CD-переменную
`IIKO_LICENSE_MODULE_ID` и скрытую protected-переменную
`IIKO_SIGNING_KEY_B64` с приватным ключом в Base64. Выданный порталом
`binding.jwt` хранится рядом с проектом плагина и автоматически помещается
рядом с DLL.

Значение автоматически попадёт и в атрибут плагина, и в `Manifest.xml`. Сборка с `Module ID = 0` предназначена только для проверки компиляции и не устанавливается в рабочий iikoFront.

Приватный `.snk` нельзя добавлять в Git, CI artifacts или загружать в портал
iiko. На портал передаётся только экспортированный из него `.pub`. Все релизы
одного плагина должны подписываться одной и той же ключевой парой.

`binding.jwt` должен соответствовать одновременно Module ID и публичному ключу
сборки. Его нельзя заменять binding-файлом другого приложения или другой пары
ключей. Файл не содержит приватного ключа и является распространяемой частью
плагина.

## Сопряжение

1. В веб-админке BrooklynBowl откройте «Сотрудники» и создайте одноразовый код.
2. Скопируйте `BridgeConfig.example.json` в папку плагина под именем `BridgeConfig.json` и укажите одноразовый код. Рабочий адрес сервера уже задан: `https://order.brooklynbowl.ru`.
3. Скопируйте DLL, `binding.jwt`, `Newtonsoft.Json.dll`, `Manifest.xml` и `BridgeConfig.json` в отдельную папку внутри `C:\Program Files\iiko\iikoRMS\Front.Net\Plugins`.
4. Перезапустите iikoFront. После первого запуска токен сохранится через Windows DPAPI в `%ProgramData%\BrooklynBowl\IikoFrontBridge`.

Плагин открывает только исходящее HTTPS/WSS-соединение. Входящие порты в сети ресторана не нужны.
