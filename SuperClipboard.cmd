@echo off
rem ============================================================
rem  SuperClipboard - chay ung dung desktop
rem  Nhap dup vao tep nay de mo SuperClipboard.
rem ============================================================
setlocal
cd /d "%~dp0"

if not exist "helper\SuperClipHelper.exe" (
  echo [SuperClipboard] Chua co helper, dang bien dich...
  node "tools\build-helper.js" || goto :err
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo [SuperClipboard] Chua co Electron, dang cai dat...
  call npm install || goto :err
)

echo [SuperClipboard] Dang khoi dong...
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0

:err
echo.
echo [SuperClipboard] Khoi dong that bai. Xem huong dan trong README.md
pause
exit /b 1
