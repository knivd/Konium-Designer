@echo off
rem Double-click to run Konium Designer in development mode (Windows).
rem Installs dependencies on first run, then starts Vite and opens the browser.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed: https://nodejs.org & pause & exit /b 1)
if not exist node_modules\.bin\vite.cmd (
  echo Installing dependencies, first run only...
  call npm.cmd install || (echo npm install failed. & pause & exit /b 1)
)
call npm.cmd run dev -- --open
pause
