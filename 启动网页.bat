@echo off
cd /d "%~dp0"
echo Starting local server. Open http://localhost:8080 in your browser.
echo Close this window to stop the server.
start "" http://localhost:8080
node serve.js
pause
