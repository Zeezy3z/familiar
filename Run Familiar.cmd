@echo off
rem Builds and starts the Familiar companion (runs in the system tray).
setlocal
set "HERE=%~dp0"
if "%HERE:~0,2%"=="\\" (
  echo Familiar cannot run from a network path ^(%HERE%^). Copy the folder to C:\Familiar and run it from there.
  goto :fail
)
echo %HERE% | find /i "\OneDrive\" >nul && (
  echo WARNING: Familiar is inside OneDrive. OneDrive will sync hundreds of MB of program files and can break the addon link. Move the folder to C:\Familiar.
  echo.
)
cd /d "%HERE%companion" || goto :fail
where node >nul 2>nul || (
  echo Familiar needs Node.js 24 or newer. Install the LTS from https://nodejs.org and run this again.
  goto :fail
)
set NODE_MAJOR=
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if not defined NODE_MAJOR (
  echo Familiar needs Node.js 24 or newer. Install the LTS from https://nodejs.org and run this again.
  goto :fail
)
if %NODE_MAJOR% LSS 24 (
  for /f %%v in ('node -v') do echo Familiar needs Node.js 24 or newer. Found %%v. Install the LTS from https://nodejs.org and run this again.
  goto :fail
)
rem Already running: starting it again only opens its control panel, which loads dist\ from disk.
rem Installing or rebuilding under it would fail on locked files or pair new panel code with the
rem old main process, so skip straight to the start.
powershell -NoProfile -NonInteractive -Command "exit [int]!(Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*%HERE%companion*' })"
if not errorlevel 1 goto :start
rem Dependencies: installed from the lockfile, once per lockfile. The stamp is written only after a
rem complete install, so a half-failed one retries, and a changed package-lock.json reinstalls.
set LOCK=
for /f %%h in ('certutil -hashfile package-lock.json SHA256 ^| find /v ":"') do if not defined LOCK set LOCK=%%h
set STAMP=node_modules\.familiar-installed
set HAVE=
if exist "%STAMP%" set /p HAVE=<"%STAMP%"
if not "%HAVE%"=="%LOCK%" (
  echo Installing dependencies ^(about 800 MB, a few minutes^)...
  call npm ci --no-audit --no-fund || goto :fail
  >"%STAMP%" echo %LOCK%
)
rem Electron's npm package no longer downloads its binary on install (no postinstall script since
rem Electron 44); its install script does. Run it whenever the exe is missing.
if not exist node_modules\electron\dist\electron.exe (
  echo Downloading Electron ^(about 120 MB^)...
  call node node_modules\electron\install.js || goto :fail
)
call node scripts\build.mjs || goto :fail
:start
start "" /b "%HERE%companion\node_modules\electron\dist\electron.exe" "%HERE%companion" %*
exit /b 0
:fail
echo Familiar failed to start. See the messages above.
if /i not "%~1"=="--background" pause
exit /b 1
