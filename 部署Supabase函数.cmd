@echo off
setlocal
chcp 65001 >nul
title 部署校园助手 Supabase 函数
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 goto no_node

where npx.cmd >nul 2>nul
if errorlevel 1 goto no_npx

echo [1/2] 登录 Supabase...
echo 浏览器打开后，请使用本项目对应的 Supabase 账号完成授权。
call npx.cmd supabase login
if errorlevel 1 goto login_failed

echo.
echo [2/2] 部署 campus-ai 后端函数...
call npx.cmd supabase functions deploy campus-ai --project-ref hadujcmbmgkypdqgulyh --no-verify-jwt --use-api
if errorlevel 1 goto deploy_failed

echo.
echo 部署成功。请重新发布前端文件，然后按 Ctrl+F5 刷新网页。
pause
exit /b 0

:no_node
echo 未找到 Node.js，请先安装或修复 Node.js 环境变量。
pause
exit /b 1

:no_npx
echo 未找到 npx.cmd，请重新安装 Node.js（需要包含 npm）。
pause
exit /b 1

:login_failed
echo.
echo Supabase 登录没有完成，请检查上方错误信息后重试。
pause
exit /b 1

:deploy_failed
echo.
echo 函数部署失败，请保留本窗口并把上方错误信息发给维护者。
pause
exit /b 1
