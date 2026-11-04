@echo off
rem Starts the Familiar companion (runs in the system tray). The release download is prebuilt and
rem starts straight away; a git clone first installs dependencies and builds.
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
rem The release download (FamiliarApp-*-windows.zip) ships dist\ and node_modules\ ready to run,
rem marked by companion\.prebuilt (scripts\prebuilt.mjs): no Node, npm or build step.
if exist .prebuilt (
  if not exist node_modules\electron\dist\electron.exe goto :incomplete
  if not exist dist\main.js goto :incomplete
  rem Anthropic's licence keeps Claude Code out of the download: fetch-claude.cjs downloads the
  rem version package-lock.json pins from npm and checks it, and returns at once when it is there.
  rem Not at login, with --background: that must not wait on a download.
  if /i not "%~1"=="--background" call :fetchclaude
  goto :start
)
echo This window installs and starts Familiar. Leave it open; the first run can take several minutes.
where node >nul 2>nul || goto :nonode
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
echo Familiar is starting. Look for its window and the tray icon at the bottom right.
start "" /b "%HERE%companion\node_modules\electron\dist\electron.exe" "%HERE%companion" %*
if defined CLAUDE_FAILED pause
exit /b 0
:fetchclaude
rem The bundled Electron runs the script as plain Node; it must not stay set for the start above.
set "ELECTRON_RUN_AS_NODE=1"
"%HERE%companion\node_modules\electron\dist\electron.exe" fetch-claude.cjs
set "FETCH=%errorlevel%"
set "ELECTRON_RUN_AS_NODE="
if "%FETCH%"=="0" exit /b 0
set CLAUDE_FAILED=1
echo.
echo Claude Code could not be downloaded, so Claude will not work in Familiar until it is.
echo Codex and the other agents still work. Run Familiar.cmd again to retry the download.
echo.
exit /b 0
:incomplete
echo This Familiar download is incomplete: companion\node_modules\electron\dist\electron.exe or companion\dist\main.js is missing.
echo Extract the whole FamiliarApp ZIP again. If antivirus removed a file, restore it first.
goto :fail
:nonode
rem Only a git clone gets here: the release download needs no Node.
echo Running Familiar from a git clone needs Node.js 24 or newer. The FamiliarApp ZIP from the Releases page needs no Node.
if /i "%~1"=="--background" goto :nodehint
where winget >nul 2>nul || goto :nodehint
choice /c YN /m "Install Node.js LTS now with winget"
if errorlevel 2 goto :nodehint
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements || goto :fail
echo Node.js is installed. Close this window, then double-click Run Familiar.cmd again.
pause
exit /b 1
:nodehint
echo Install the LTS from https://nodejs.org and run this again.
goto :fail
:fail
echo Familiar failed to start. See the messages above.
if /i not "%~1"=="--background" pause
exit /b 1
