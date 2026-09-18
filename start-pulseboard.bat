@echo off
setlocal

cd /d "%~dp0"
set "PULSEBOARD_URL=http://localhost:3001"
set "PULSEBOARD_HEALTH_URL=http://127.0.0.1:3001/healthz"

where npm >nul 2>&1
if errorlevel 1 (
  echo [Pulseboard] npm was not found. Install Node.js 22 or newer and try again.
  pause
  exit /b 1
)

rem If Pulseboard is already healthy, open it without starting a duplicate API.
powershell.exe -NoProfile -NonInteractive -Command "try { $response = Invoke-WebRequest -Uri '%PULSEBOARD_HEALTH_URL%' -UseBasicParsing -TimeoutSec 2; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 goto :open_browser

echo [Pulseboard] Starting API from %CD% ...
start "Pulseboard API" /D "%~dp0" cmd.exe /k "npm run api"

echo [Pulseboard] Waiting for the API to become ready ...
for /l %%I in (1,1,60) do (
  powershell.exe -NoProfile -NonInteractive -Command "try { $response = Invoke-WebRequest -Uri '%PULSEBOARD_HEALTH_URL%' -UseBasicParsing -TimeoutSec 1; if ($response.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
  if not errorlevel 1 goto :open_browser
  timeout /t 1 /nobreak >nul
)

echo [Pulseboard] The API did not become ready within 60 seconds.
echo [Pulseboard] Review the Pulseboard API window for the startup error.
pause
exit /b 1

:open_browser
echo [Pulseboard] Opening %PULSEBOARD_URL% ...
start "" "%PULSEBOARD_URL%"
endlocal
exit /b 0
