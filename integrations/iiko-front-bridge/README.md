# BrooklynBowl iikoFront Bridge

Локальный плагин для iikoFront 9.4. Он синхронизирует сотрудников с сервером BB Kiosk и проверяет PIN внутри iikoFront. PIN не сохраняется ни в плагине, ни на сервере.

Плагин использует стабильную LTS-версию iikoFront API V8. Это правильная версия
для iikoFront 9.4: стабильная V9 доступна начиная с iikoRMS 9.5, а V8
поддерживается до iikoRMS 10.3 включительно.

## Сборка

Требуются Windows, .NET SDK и выданный iiko `Module ID`:

```powershell
.\build.ps1 -ModuleId ВАШ_MODULE_ID
```

Готовый ZIP появится в `artifacts`. В GitLab сборка описана ручной задачей
`build_iiko_front_plugin`; для рабочей сборки задайте CI/CD-переменную
`IIKO_LICENSE_MODULE_ID`.

Значение автоматически попадёт и в атрибут плагина, и в `Manifest.xml`. Сборка с `Module ID = 0` предназначена только для проверки компиляции и не устанавливается в рабочий iikoFront.

## Сопряжение

1. В веб-админке BrooklynBowl откройте «Сотрудники» и создайте одноразовый код.
2. Скопируйте `BridgeConfig.example.json` в папку плагина под именем `BridgeConfig.json` и укажите одноразовый код. Рабочий адрес сервера уже задан: `https://order.brooklynbowl.ru`.
3. Скопируйте DLL, `Newtonsoft.Json.dll`, `Manifest.xml` и `BridgeConfig.json` в отдельную папку внутри `C:\Program Files\iiko\iikoRMS\Front.Net\Plugins`.
4. Перезапустите iikoFront. После первого запуска токен сохранится через Windows DPAPI в `%ProgramData%\BrooklynBowl\IikoFrontBridge`.

Плагин открывает только исходящее HTTPS/WSS-соединение. Входящие порты в сети ресторана не нужны.
