@echo off
title Chienzhi Story server
cd /d "%~dp0"

netstat -ano | findstr "127.0.0.1:8765" | findstr "LISTENING" 1>nul && (
  echo Server is already running. Opening the game in your browser...
  start "" http://127.0.0.1:8765
  exit /b
)

echo Starting the game server at http://127.0.0.1:8765
echo Keep this window open while playing. Close it to stop the server.
echo Images need ComfyUI running at 127.0.0.1:8000.
echo.
start "" powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest http://127.0.0.1:8765/api/health -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process http://127.0.0.1:8765; break } catch { Start-Sleep 1 } }"
python -m server.main

echo.
echo The server has stopped. If you see an error above, check that Python and requirements.txt are installed.
pause
