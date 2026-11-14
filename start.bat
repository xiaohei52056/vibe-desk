@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   VIBE DESK  local services
echo ============================================
echo.
echo NOTE: dev DB password is root/123456789. Change it below if needed.
echo.

where mysql >nul 2>&1
if errorlevel 1 (
  echo [!] mysql client not found in PATH. Start MySQL first.
  pause
  exit /b 1
)

mysql -uroot -p123456789 -e "SELECT 1" >nul 2>&1
if errorlevel 1 (
  echo [!] MySQL not reachable. Check service and password in this script.
  pause
  exit /b 1
)

echo [1/4] Init database ^(safe to re-run^) ...
mysql -uroot -p123456789 < "backend\src\main\resources\init-db.sql" >nul 2>&1

if not exist "node_modules" (
  echo [2/4] Installing frontend deps ...
  call npm install
)

if not exist "backend\target\vibe-desk-server-1.0.0.jar" (
  echo [2/4] Building backend jar ^(first run only^) ...
  pushd backend
  call mvn -q package -DskipTests
  popd
)

echo [3/4] Starting backend on 8080 ...
start "VIBE-DESK backend" /D "%~dp0backend" cmd /k "java -jar target\vibe-desk-server-1.0.0.jar"

echo       waiting 10s for Spring Boot ...
timeout /t 10 /nobreak >nul

echo [4/4] Starting frontend on 5173 ...
start "VIBE-DESK frontend" /D "%~dp0" cmd /k "npx vite --port 5173 --strictPort --host 0.0.0.0"

timeout /t 5 /nobreak >nul
start "" "http://localhost:5173/?v=%RANDOM%"

echo.
echo Done. Keep both console windows open. Close them to stop the services.
echo If ports are already in use, close the old windows first.
pause
