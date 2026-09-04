@echo off
setlocal EnableExtensions

set "REPO_ROOT=%~1"
if not defined REPO_ROOT (
  echo ERROR: repository root is required.
  exit /b 1
)

set "ENV_FILE=%REPO_ROOT%\.env"
set "TEMPLATE_FILE=%REPO_ROOT%\.env.example"

if exist "%ENV_FILE%" goto ensure_switches
if not exist "%TEMPLATE_FILE%" (
  echo ERROR: Missing environment template: %REPO_ROOT%\.env.example
  exit /b 1
)

copy /Y "%TEMPLATE_FILE%" "%ENV_FILE%" >nul
if errorlevel 1 (
  echo ERROR: Could not create %REPO_ROOT%\.env from .env.example.
  exit /b 1
)

echo Created %REPO_ROOT%\.env from .env.example.

:ensure_switches
call :ensure_key MUSE_EDITION || exit /b 1
call :ensure_empty_key AUTH_FIXED_VERIFICATION_CODE || exit /b 1
call :render_runtime_env || exit /b 1
exit /b 0

:ensure_key
findstr /R /C:"^[ ]*%~1[ ]*=" "%ENV_FILE%" >nul
if not errorlevel 1 exit /b 0
for /f "usebackq delims=" %%L in (`findstr /B /C:"%~1=" "%TEMPLATE_FILE%"`) do (
  >>"%ENV_FILE%" echo(
  >>"%ENV_FILE%" echo %%L
  echo Added missing %~1 setting to %ENV_FILE%.
  exit /b 0
)
echo ERROR: Missing %~1 in %TEMPLATE_FILE%.
exit /b 1

:ensure_empty_key
findstr /R /C:"^[ ]*%~1[ ]*=" "%ENV_FILE%" >nul
if not errorlevel 1 exit /b 0
>>"%ENV_FILE%" echo(
>>"%ENV_FILE%" echo %~1=
echo Added missing %~1 setting to %ENV_FILE% ^(disabled until explicitly configured^).
exit /b 0

:render_runtime_env
setlocal EnableDelayedExpansion
set "EDITION="
set "FIXED_CODE="
for /f "usebackq tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
  set "KEY=%%A"
  if /I "!KEY!"=="MUSE_EDITION" set "EDITION=%%B"
  if /I "!KEY!"=="AUTH_FIXED_VERIFICATION_CODE" set "FIXED_CODE=%%B"
)
if /I "!EDITION!"=="community" set "EDITION=community"
if /I "!EDITION!"=="saas" set "EDITION=saas"
if not "!EDITION!"=="community" if not "!EDITION!"=="saas" (
  echo ERROR: MUSE_EDITION in %ENV_FILE% must be community or saas.
  endlocal & exit /b 1
)
if defined FIXED_CODE (
  echo(!FIXED_CODE!| findstr /R /X "[0-9][0-9][0-9][0-9][0-9][0-9]" >nul
  if errorlevel 1 (
    echo ERROR: AUTH_FIXED_VERIFICATION_CODE in %ENV_FILE% must be empty or exactly 6 digits.
    endlocal & exit /b 1
  )
)
set "RUNTIME_ENV=%REPO_ROOT%\.env.community-runtime"
for /f %%G in ('powershell -NoProfile -Command "[guid]::NewGuid()"') do set "RUNTIME_GUID=%%G"
if not defined RUNTIME_GUID (
  echo ERROR: Could not allocate a unique Community runtime temporary file.
  endlocal & exit /b 1
)
set "RUNTIME_TEMP=!RUNTIME_ENV!.tmp.!RUNTIME_GUID!"
>"!RUNTIME_TEMP!" echo MUSE_EDITION=!EDITION!
>>"!RUNTIME_TEMP!" echo AUTH_FIXED_VERIFICATION_CODE=!FIXED_CODE!
move /Y "!RUNTIME_TEMP!" "!RUNTIME_ENV!" >nul
if errorlevel 1 (
  del /Q "!RUNTIME_TEMP!" >nul 2>&1
  echo ERROR: Could not prepare isolated Community runtime switches.
  endlocal & exit /b 1
)
echo Prepared isolated Community runtime switches from %ENV_FILE%.
endlocal & exit /b 0
