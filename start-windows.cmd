@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo Please install Node.js 22 or newer from nodejs.org & pause & exit /b 1)
node --input-type=module -e "if (+process.versions.node.split('.')[0] < 22) process.exit(1)"
if errorlevel 1 (echo Node.js 22 or newer is required & pause & exit /b 1)
echo Open http://127.0.0.1:4318 and copy the management code shown below.
node server.mjs
pause
