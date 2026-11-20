@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)
node scripts\install.mjs %*
if errorlevel 1 (
  echo.
  echo 部署失败，请查看上方错误信息。
  pause
  exit /b 1
)
pause
