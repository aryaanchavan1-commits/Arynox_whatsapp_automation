@echo off
cd /d "%~dp0"
echo Starting Arynox WhatsApp Automation...
start "Arynox WhatsApp Automation" cmd /k "npm start"
timeout /t 4 >nul
start "" "http://localhost:3000"
echo Dashboard opened in your browser. QR code will appear there.
pause