@echo off
setlocal
call "%~dp0_dev-env.bat"
if not exist "%PYTHON_BIN%" (
  echo [ERROR] Missing Windows virtual environment: %PYTHON_BIN%
  echo Create apps\tabtin_django\venv-windows before starting Muse.
  exit /b 1
)
call "%~dp0docker-ready.bat" || exit /b 1
echo [INFRA] Starting PostgreSQL and Redis with Docker Compose...
docker compose -f "%ROOT_DIR%\docker-compose.dev.yml" up -d postgres redis
if errorlevel 1 exit /b 1
echo [INFRA] Waiting for PostgreSQL readiness, timeout 60 seconds...
for /l %%I in (1,1,60) do (
  docker exec tabtin-postgres-dev pg_isready -U tabtin -d tabtin_single >nul 2>&1 && goto ready
  ping 127.0.0.1 -n 2 >nul
)
echo [ERROR] PostgreSQL did not become ready within 60 seconds.
exit /b 1
:ready
set "TABTIN_EDITION=community"
set "TABTIN_COMMUNITY_DEV_MODE=1"
set "TABTIN_COMMUNITY_DATABASE_SQL_ROOT=%ROOT_DIR%\community-assets\postgres"
set "PG_DB_HOST=127.0.0.1"
set "PG_DB_PORT=5432"
set "PG_DB_USER=tabtin"
if not defined PG_DB_PASSWORD set "PG_DB_PASSWORD=tabtin_dev_pass"
pushd "%DJANGO_DIR%"
echo [DATABASE] Repairing Community database roles...
"%PYTHON_BIN%" -m tabtin.community_database sync
if errorlevel 1 (
  echo [ERROR] Community database role repair failed.
  popd
  exit /b 1
)
echo [DATABASE] Applying managed migrations with safe_migrate...
set "PG_DB_USER=tabtin_migrator"
"%PYTHON_BIN%" manage.py safe_migrate --noinput
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" (
  echo [ERROR] Managed migrations failed.
  popd
  exit /b %RESULT%
)
echo [DATABASE] Finalizing Community database capabilities...
set "PG_DB_USER=tabtin"
"%PYTHON_BIN%" -m tabtin.community_database finalize
if errorlevel 1 (
  echo [ERROR] Community database finalization failed.
  popd
  exit /b 1
)
echo [DATABASE] Verifying Community database capabilities...
"%PYTHON_BIN%" -m tabtin.community_database verify
if errorlevel 1 (
  echo [ERROR] Community database capability verification failed.
  popd
  exit /b 1
)
popd
"%PYTHON_BIN%" "%DJANGO_DIR%\manage.py" seed_scene_bindings --if-empty
if errorlevel 1 echo [WARN] Scene binding seed failed; startup will continue.
"%PYTHON_BIN%" "%DJANGO_DIR%\manage.py" provision_dev_agent_ready
if errorlevel 1 echo [WARN] Development agent provisioning failed; startup will continue.
exit /b 0
