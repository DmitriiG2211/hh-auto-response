@echo off
setlocal
chcp 65001 >nul

set "HH_AUTO_DIR=%~dp0"
set "HH_AUTO_URL=http://127.0.0.1:8787"
set "HH_AUTO_NODE=%ProgramFiles%\nodejs\node.exe"

call :is_running
if not errorlevel 1 goto open_page

if not exist "%HH_AUTO_NODE%" (
  set "HH_AUTO_NODE="
  for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined HH_AUTO_NODE set "HH_AUTO_NODE=%%N"
)

if not defined HH_AUTO_NODE goto node_missing
if not exist "%HH_AUTO_NODE%" goto node_missing

start "HH Auto server" /min "%HH_AUTO_NODE%" "%HH_AUTO_DIR%server.mjs"
ping.exe 127.0.0.1 -n 3 >nul

call :is_running
if errorlevel 1 goto server_failed

:open_page
if /i "%~1"=="--no-open" exit /b 0
start "" "%HH_AUTO_URL%"
exit /b 0

:is_running
curl.exe -fsSI --max-time 1 "%HH_AUTO_URL%" 2>nul | findstr /i /c:"X-HH-Auto: 1" >nul
exit /b %errorlevel%

:node_missing
echo.
echo Не найден Node.js. Ожидаемый путь:
echo %ProgramFiles%\nodejs\node.exe
echo.
pause
exit /b 1

:server_failed
echo.
echo Не удалось запустить HH Auto на %HH_AUTO_URL%.
echo Проверьте файл hh-auto-server.error.log в папке проекта.
echo.
pause
exit /b 1
