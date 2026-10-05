@echo off
rem Double-click starts the current source, then this window closes.
rem pnpm dev keeps running on its own; closing this launcher does not stop the app.
setlocal
cd /d "%~dp0"
where pnpm >nul 2>&1
if errorlevel 1 (
  echo [FF-pane] pnpm was not found. Install pnpm, then double-click again.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','pnpm dev' -WorkingDirectory '%CD%' -WindowStyle Hidden"
endlocal
