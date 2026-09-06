@echo off
rem FF-pane launcher: double-click to start the packaged desktop app.
rem The real FF-pane.exe lives in apps\desktop\release\win-unpacked\ (build
rem output, ~230 MB, not tracked by git), so it cannot sit in the repo root;
rem this tiny script locates and starts it instead.
rem If the exe is missing, run "pnpm package" in the repo root first.
setlocal
set "EXE=%~dp0apps\desktop\release\win-unpacked\FF-pane.exe"
if exist "%EXE%" (
  start "" "%EXE%"
) else (
  echo [FF-pane] Packaged app not found:
  echo   %EXE%
  echo.
  echo Run "pnpm package" in the repo root first, then double-click again.
  echo.
  pause
)
endlocal
