@echo off
setlocal
call "%~dp0_dev-env.bat"
echo [BUILD] Preparing workspace dependencies for collab-live...
node "%~dp0..\electron\run-predev-build-with-lock.mjs" --seed collab-live
if errorlevel 1 (
  echo [ERROR] Workspace dependency build for collab-live failed.
  exit /b 1
)
call "%~dp0_kill-port.bat" "%COLLAB_LIVE_PORT%"
set "NODE_ENV=development"
set "PORT=%COLLAB_LIVE_PORT%"
set "DJANGO_API_URL=http://127.0.0.1:%DJANGO_BIND_PORT%"
set "COLLAB_LIVE_DIR=%ROOT_DIR%\apps\collab-live"
echo [COLLAB] Preparing workspace dependencies...
if "%MUSE_SKIP_COLLAB_WORKSPACE_BUILD%"=="1" (
  echo [COLLAB] Workspace dependencies already prepared by Community topology; skipping.
) else (
  node "%ROOT_DIR%\scripts\electron\run-predev-build-with-lock.mjs" --seed collab-live
  if errorlevel 1 (
    echo [ERROR] Workspace dependency build failed; inspect the terminal output.
    exit /b 1
  )
)
powershell -NoProfile -Command "$a=@('exec','tsx','src/start.ts'); $p=Start-Process -FilePath 'pnpm.cmd' -WorkingDirectory $env:COLLAB_LIVE_DIR -ArgumentList $a -RedirectStandardOutput ($env:LOG_DIR+'\collab-live.log') -RedirectStandardError ($env:LOG_DIR+'\collab-live.error.log') -WindowStyle Hidden -PassThru; Set-Content -Path ($env:LOG_DIR+'\collab-live.pid') -Value $p.Id"
if errorlevel 1 exit /b 1
exit /b 0
