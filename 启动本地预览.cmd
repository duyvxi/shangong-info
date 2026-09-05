@echo off
setlocal
chcp 65001 >nul
title Shangong Info Local Preview
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 goto no_node

echo Starting local preview...
node.exe scripts\dev-server.mjs
if errorlevel 1 goto failed
goto done

:no_node
echo Node.js was not found.
echo Install Node.js or open the deployed website instead.
pause
exit /b 1

:failed
echo.
echo Local preview failed. Please read the error message above.
pause
exit /b 1

:done
endlocal
