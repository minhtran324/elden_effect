@echo off
title LiveEffect Studio Pro - TikTok Live Stream
cd /d "%~dp0"

echo ======================================================================
echo    LIVEEFFECT STUDIO PRO - TRINH DIEU KHIEN VA HU QUA TIKTOK LIVE
echo ======================================================================
echo.

set "NODE_BIN="
if exist "%~dp0runtime\node.exe" (
    set "NODE_BIN=%~dp0runtime\node.exe"
    echo [OK] Su dung Node.js Portable tich hop san: runtime\node.exe
) else (
    where node >nul 2>nul
    if %errorlevel% equ 0 (
        set "NODE_BIN=node"
        echo [OK] Su dung Node.js cua he thong.
    )
)

if "%NODE_BIN%"=="" (
    echo [LOI] Khong tim thay Node.js tren may tinh!
    echo Vui long cai dat Node.js tu https://nodejs.org hoac kiem tra thu muc runtime.
    echo.
    pause
    exit /b 1
)

echo Dang khoi dong may chu va tu dong bat trinh duyet...
echo (Hay thu nho cua so nay xuong thanh Taskbar khi dang Live)
echo ======================================================================
echo.

"%NODE_BIN%" server.js --open

echo.
echo ======================================================================
echo May chu da dung lai.
echo ======================================================================
pause