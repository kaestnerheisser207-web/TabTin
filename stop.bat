@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set COMPOSE_DISABLE_ENV_FILE=1
set "MUSE_EDITION="
set "AUTH_FIXED_VERIFICATION_CODE="

where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker was not found.
  exit /b 1
)

if not exist "%~dp0.env" (
  echo ERROR: Missing %~dp0.env. Run start.bat once before stopping Muse Community.
  exit /b 1
)

call "%~dp0scripts\community\ensure-env-file.bat" "%~dp0"
if errorlevel 1 exit /b 1

docker compose --env-file "%~dp0.env" down
if errorlevel 1 (
  echo ERROR: Muse Community could not be stopped cleanly.
  exit /b 1
)

echo Muse Community is stopped. Your data volumes are preserved.
exit /b 0
