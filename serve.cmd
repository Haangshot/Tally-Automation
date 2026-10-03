@echo off
REM Start the local HTTP server.
setlocal
cd /d "%~dp0"
node bin\tally-agent.js serve %*
if errorlevel 1 pause
endlocal
