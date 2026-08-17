# BrooklynBowl iikoFront Bridge

Локальный плагин для iikoFront 9.4. Он синхронизирует сотрудников с сервером BrooklynBowl и проверяет PIN внутри iikoFront. PIN не сохраняется ни в плагине, ни на сервере.

## Сборка

Требуются Windows, .NET SDK и выданный iiko `Module ID`:

```powershell
.\build.ps1 -ModuleId ВАШ_MODULE_ID
```

Готовый ZIP появится в `artifacts`. Ту же сборку можно запустить вручную в GitHub Actions через workflow **iikoFront Bridge**, указав Module ID при запуске.

Значение автоматически попадёт и в атрибут плагина, и в `Manifest.xml`. Сборка с `Module ID = 0` предназначена только для проверки компиляции и не устанавливается в рабочий iikoFront.

## Сопряжение

1. В веб-админке BrooklynBowl откройте «Сотрудники» и создайте одноразовый код.
2. Скопируйте `BridgeConfig.example.json` в папку плагина под именем `BridgeConfig.json`, укажите код и адрес сервера.
3. Скопируйте DLL, `Newtonsoft.Json.dll`, `Manifest.xml` и `BridgeConfig.json` в отдельную папку внутри `C:\Program Files\iiko\iikoRMS\Front.Net\Plugins`.
4. Перезапустите iikoFront. После первого запуска токен сохранится через Windows DPAPI в `%ProgramData%\BrooklynBowl\IikoFrontBridge`.

Плагин открывает только исходящее HTTPS/WSS-соединение. Входящие порты в сети ресторана не нужны.
