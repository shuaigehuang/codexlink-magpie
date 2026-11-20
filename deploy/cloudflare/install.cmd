@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

set "NODE_EXE=node"
if defined CODEXLINK_NODE set "NODE_EXE=%CODEXLINK_NODE%"

"%NODE_EXE%" --version >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
)

"%NODE_EXE%" --version >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found.
  echo Install Node.js 20 or newer from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" scripts\install.mjs %*
if errorlevel 1 (
  echo.
  echo Deployment failed. Please read the error above.
  pause
  exit /b 1
)

echo.
pause
