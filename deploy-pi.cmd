@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0ops\pi\deploy.ps1" %*
exit /b %ERRORLEVEL%
