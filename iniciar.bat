@echo off
rem Piano Tutor: doble clic para arrancar. Abre la app en el navegador.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Falta Node.js. Bajalo e instalalo desde https://nodejs.org ^(version LTS^)
  echo  y despues volve a abrir este archivo.
  echo.
  pause
  exit /b 1
)

start "" http://localhost:3737
echo  Piano Tutor corriendo. Cerra esta ventana para apagarlo.
node server.js
pause
