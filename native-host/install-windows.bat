@echo off
rem ============================================================
rem  CaptureDesk native host installer (Windows, per-user)
rem  Registers com.capturedesk.host for Chrome + Chromium-family
rem  browsers under HKCU. Requires Node.js 18+ on PATH.
rem ============================================================
setlocal enabledelayedexpansion

set HOST_ID=com.capturedesk.host
set HERE=%~dp0
set NODE_EXE=

for %%P in (node.exe) do set NODE_EXE=%%~$PATH:P
if not defined NODE_EXE (
  echo [CaptureDesk] Node.js was not found on PATH. Install Node.js 18+ first.
  exit /b 1
)

rem Path of the native host script, Windows style.
set HOST_JS=%HERE%native-host.js
set HOST_JS_FWD=%HOST_JS:\=/%

rem Generate the per-machine manifest with absolute paths.
> "%HERE%com.capturedesk.host.json.generated" (
  echo {
  echo   "name": "%HOST_ID%",
  echo   "description": "CaptureDesk native messaging host",
  echo   "path": "%HOST_JS%",
  echo   "type": "stdio",
  echo   "allowed_origins": [ "chrome-extension://REPLACE_WITH_EXTENSION_ID/" ]
  echo }
)

echo [CaptureDesk] Manifest written to %HERE%com.capturedesk.host.json.generated
echo [CaptureDesk] Replace REPLACE_WITH_EXTENSION_ID with your extension's ID,
echo               then the installer below registers it.

set MANIFEST=%HERE%com.capturedesk.host.json.generated

reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_ID%" /ve /t REG_SZ /d "%MANIFEST%" /f
reg add "HKCU\Software\Chromium\NativeMessagingHosts\%HOST_ID%" /ve /t REG_SZ /d "%MANIFEST%" /f
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_ID%" /ve /t REG_SZ /d "%MANIFEST%" /f

echo [CaptureDesk] Native host registered for Chrome, Chromium and Edge.
endlocal
