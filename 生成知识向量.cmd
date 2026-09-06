@echo off
setlocal
title Campus AI Knowledge Vector Setup
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\reindex_knowledge.ps1"
set "result=%errorlevel%"

echo.
if "%result%"=="0" (
    echo Finished. Read the result above.
) else (
    echo Failed. Keep this window open and send a screenshot of the error above.
)
pause
exit /b %result%
