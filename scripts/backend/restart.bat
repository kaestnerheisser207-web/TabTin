@echo off
echo ============================================================
echo              Restarting Muse backend stack
echo ============================================================
call "%~dp0stop.bat" || exit /b 1
call "%~dp0start.bat"
exit /b %ERRORLEVEL%
