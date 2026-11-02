#!/usr/bin/env bash
# Dev helper: restart FakeWoW (optional) and the companion in dev mode. Usage: scripts/dev-restart.sh [--fake]
cd "$(dirname "$0")/.."
kill_tree() { powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { \$_.CommandLine -match '$1' } | ForEach-Object { taskkill /F /T /PID \$_.ProcessId | Out-Null }"; }
kill_tree 'electron\.exe"?\s+\.\s'
if [ "$1" == "--fake" ]; then kill_tree 'fakewow-main'; (FAMILIAR_DEV=1 npx electron dist/fakewow-main.js --minutes 30 >/dev/null 2>&1 &); sleep 3; fi
rm -f "$APPDATA/Familiar/familiar.log"
(FAMILIAR_DEV=1 FAMILIAR_TARGET_TITLE=FakeWoW FAMILIAR_CAPTURE=${FAMILIAR_CAPTURE:-window} npx electron . --background >/dev/null 2>&1 &)
sleep 8
tail -5 "$APPDATA/Familiar/familiar.log" | cut -c1-200
