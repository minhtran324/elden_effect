@echo off
title Tat LiveEffect Studio
cd /d "%~dp0"

echo ======================================================================
echo    DANG TAT LIVEEFFECT STUDIO...
echo ======================================================================
echo.

for /f "tokens=5" %%a in ('netstat -aon ^| find ":3000" ^| find "LISTENING"') do (
    echo Dong tien trinh Port 3000 PID: %%a
    taskkill /f /pid %%a >nul 2>nul
)

echo Da tat LiveEffect Studio hoan tat!
ping 127.0.0.1 -n 3 >nul