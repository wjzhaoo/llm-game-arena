@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo Please install Node.js 22.13 or newer from nodejs.org & pause & exit /b 1)
node --input-type=module -e "const [major,minor]=process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 13)) process.exit(1)"
if errorlevel 1 (echo Node.js 22.13 or newer is required & pause & exit /b 1)
echo Open the local address below and copy the management code. LAN addresses can be shared with players.
node server.mjs
pause
