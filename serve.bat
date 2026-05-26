@echo off
REM tinySAmomo - launch local server and open in default Chromium browser
REM WebSerial requires http://localhost (or https://). file:// is not supported.

setlocal
set PORT=8765
cd /d "%~dp0"

REM Open browser after a brief delay
start "" cmd /c "timeout /t 1 /nobreak >nul && start http://localhost:%PORT%/index.html"

echo Starting tinySAmomo on http://localhost:%PORT%
echo Press Ctrl+C to stop.
python -m http.server %PORT%
endlocal
