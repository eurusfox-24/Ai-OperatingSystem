@echo off
title Forest Joensuu AI OS - One-Click Launcher
echo ===================================================
echo   Forest Joensuu & Business Joensuu AI OS Launcher
echo ===================================================
echo.

cd /d "%~dp0"

echo [1/3] Starting Python AI OS Kernel Daemon (Port 8000)...
start "AI OS Kernel Daemon" /min cmd /c ".venv\Scripts\python.exe -m kernel.main"

timeout /t 2 /nobreak >nul

echo [2/3] Starting Vite UI Dev Server (Port 3000)...
cd ui
start "AI OS Desktop UI" /min cmd /c "npm run dev"

timeout /t 2 /nobreak >nul

echo [3/3] Opening Browser Interface at http://localhost:3000...
start http://localhost:3000

echo.
echo ===================================================
echo   Forest Joensuu AI OS is LIVE!
echo   - Backend Kernel: http://localhost:8000
echo   - UI Dashboard:   http://localhost:3000
echo ===================================================
pause
