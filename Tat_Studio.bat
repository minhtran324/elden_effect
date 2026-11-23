@echo off
if exist "%~dp0elden-live-effect-studio\Tat_Studio.bat" (
    cd /d "%~dp0elden-live-effect-studio"
    call Tat_Studio.bat
) else if exist "%~dp0live-effect-studio\Tat_Studio.bat" (
    cd /d "%~dp0live-effect-studio"
    call Tat_Studio.bat
) else (
    echo [LOI] Khong tim thay thu muc elden-live-effect-studio!
    pause
)