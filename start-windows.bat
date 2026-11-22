@echo off
REM ============================================================
REM  AMX Guess Who - double-click starter (Windows)
REM  Uses the portable Node in runtime\ if present (no install,
REM  no admin rights). Otherwise falls back to Node on PATH.
REM  Installs NOTHING. Copy this whole folder WITH node_modules.
REM ============================================================
cd /d "%~dp0"
title AMX Guess Who Server - keep this window open

set "NODE_EXE="

if exist "runtime\node.exe" (
  set "NODE_EXE=runtime\node.exe"
  echo Using the portable Node included in this package.
) else (
  where node >nul 2>nul
  if %ERRORLEVEL%==0 (
    set "NODE_EXE=node"
    echo Using Node found on this computer.
  )
)

if not defined NODE_EXE (
  echo.
  echo  ============================================================
  echo   Node.js was not found on this computer, and this package
  echo   does not have a portable copy in its runtime folder.
  echo.
  echo   Fix: use the package version that includes the runtime\
  echo   folder, OR install Node.js LTS from nodejs.org, then
  echo   double-click this file again.
  echo  ============================================================
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\socket.io" (
  echo.
  echo  ============================================================
  echo   The node_modules folder is missing or incomplete.
  echo   This package must be copied WITH its node_modules folder
  echo   included ^(pre-installed^) - it cannot install anything
  echo   by itself, and this starter will not install silently.
  echo.
  echo   Fix: re-copy the complete package folder, then try again.
  echo  ============================================================
  echo.
  pause
  exit /b 1
)

echo.
echo  Starting AMX Guess Who...
echo  When Windows Firewall asks, ALLOW it on the Private network.
echo  Then open the HOST address shown below in your browser.
echo.
"%NODE_EXE%" server.js

echo.
echo  Server stopped. Press any key to close.
pause >nul
