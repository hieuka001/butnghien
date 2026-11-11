@echo off
chcp 65001 >nul
title But Nghien TTS Bridge - VieNeu
cd /d %~dp0

where python >nul 2>nul
if errorlevel 1 (
  echo [LOI] Chua thay Python tren may. Cai Python 3.10+ tu python.org roi chay lai.
  pause
  exit /b 1
)

if not exist .venv (
  echo Dang tao moi truong Python rieng cho bridge...
  python -m venv .venv
)

call .venv\Scripts\activate.bat
set HF_HUB_DISABLE_XET=1

if not exist .venv\.vieneu-installed (
  echo Dang cai VieNeu-TTS (chi lan dau, vai tram MB - tuy toc do mang)...
  pip install vieneu
  if errorlevel 1 (
    echo [LOI] Cai vieneu that bai. Kiem tra mang roi chay lai file nay.
    pause
    exit /b 1
  )
  echo done> .venv\.vieneu-installed
)

echo.
echo === But Nghien TTS Bridge (VieNeu) ===
echo Mo trinh duyet vao app But Nghien, bam nut NGHE o mot chuong da viet.
echo Bridge nghe tai http://127.0.0.1:3900 - de nguyen cua so nay khi dang nghe.
echo Bam Ctrl+C de dung.
echo.
python server.py
pause
