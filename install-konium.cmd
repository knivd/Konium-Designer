@echo off
rem Double-click: sets up Konium Designer's website and services from scratch, or brings them up to date.
rem Options go to install-konium.ps1, e.g.  install-konium.cmd -Steps ai,check
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-konium.ps1" %*
pause
