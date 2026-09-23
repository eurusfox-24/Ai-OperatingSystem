@echo off
title The Company AI OS - One-Click Launcher
echo ===================================================
echo   The Company AI OS Launcher
echo ===================================================
echo.

cd /d "%~dp0"

echo [1/3] Starting Python AI OS Kernel Daemon (Port 8000)...
if exist ".venv\Scripts\python.exe" (
    start "AI OS Kernel Daemon" /min cmd /c ".venv\Scripts\python.exe -m kernel.main"
) else if exist "venv\Scripts\python.exe" (
    start "AI OS Kernel Daemon" /min cmd /c "venv\Scripts\python.exe -m kernel.main"
) else (
    start "AI OS Kernel Daemon" /min cmd /c "python -m kernel.main"
)

timeout /t 2 /nobreak >nul

echo [2/3] Starting Vite UI Dev Server (Port 3000)...
pushd ui
start "AI OS Desktop UI" /min cmd /c "npm run dev"
popd

timeout /t 2 /nobreak >nul

echo [3/3] Opening Browser Interface at http://localhost:3000...
start http://localhost:3000

echo.
echo ===================================================
echo   The Company AI OS is LIVE!
echo   - Backend Kernel: http://localhost:8000
echo   - UI Dashboard:   http://localhost:3000
echo ===================================================
pause

