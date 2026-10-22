@echo off
rem ---------------------------------------------------------------
rem  LCEDA -> Altium  local launcher (ASCII only on purpose:
rem  cmd.exe parses .cmd files in the OEM code page, so Chinese
rem  text here would be split into stray commands. All Chinese
rem  messages are printed by app\server.mjs instead.)
rem ---------------------------------------------------------------
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem Portable build ships node.exe next to this file; otherwise use PATH.
set "NODE_EXE=node"
if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"
if exist "%~dp0node.exe" goto node_ok
where node >nul 2>nul
if errorlevel 1 goto no_node
:node_ok

rem Reuse a windowless instance started by the .vbs launcher (any port).
set "RUNNING="
for /f "delims=" %%p in ('call "%NODE_EXE%" "tools\probe.mjs" 2^>nul') do set "RUNNING=%%p"
if defined RUNNING if not "%RUNNING%"=="0" (
  echo.
  echo   [LCEDA2Altium] already running on port %RUNNING%.
  echo   Opening http://127.0.0.1:%RUNNING%/
  echo   Stop it with the .vbs stopper when you are done.
  echo.
  start "" "http://127.0.0.1:%RUNNING%/"
  endlocal
  exit /b 0
)

if "%PORT%"=="" set "PORT=43180"

echo.
echo   [LCEDA2Altium] starting local server, please wait...
echo   URL: http://127.0.0.1:%PORT%/
echo   Closing this window stops the server.
echo   Tip: the .vbs launcher starts it without a console window.
echo.

"%NODE_EXE%" "app\server.mjs" --open %*
set "RC=%errorlevel%"

if not "%RC%"=="0" goto failed
endlocal
exit /b 0

:failed
echo.
echo   [ERROR] server exited with code %RC%.
echo   If the message above says the port is already in use, run:
echo       set PORT=43181
echo       run.cmd
echo.
pause
endlocal
exit /b 1

:no_node
echo.
echo   [ERROR] Node.js not found.
echo   Please install Node.js 18 or newer from https://nodejs.org/
echo   then re-open this window and double-click run.cmd again.
echo.
pause
endlocal
exit /b 1
