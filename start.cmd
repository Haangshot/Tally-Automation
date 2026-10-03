@echo off
REM Start the Tally AI Agent chat. Double-click, or run from a terminal.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed, or not on PATH.
  echo Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies, one moment...
  call npm install || (echo Install failed. & pause & exit /b 1)
)

if not exist ".env" (
  echo No .env found. Copying .env.example - edit it before going further.
  copy /y ".env.example" ".env" >nul
)

node bin\tally-agent.js %*
if errorlevel 1 pause
endlocal
