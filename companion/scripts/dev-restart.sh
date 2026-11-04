#!/usr/bin/env bash
# Dev helper: restart FakeWoW (optional) and the companion in dev mode (FAMILIAR_DEV=1: dev hooks,
# no "start with Windows" entry).
#   scripts/dev-restart.sh [--fake] [--profile DIR]   (re)start; --fake also (re)starts FakeWoW
#   scripts/dev-restart.sh --stop [--profile DIR]     stop what this script started
# --profile DIR runs against a throwaway profile, never your own: APPDATA=DIR\Roaming,
# LOCALAPPDATA=DIR\Local, Chromium's user data under DIR (Electron ignores %APPDATA% for its own
# folder and single-instance lock), and on first use a config.json whose wowRoot is a fake WoW
# folder DIR\wow\_forever_, so the addon link and FamiliarSync never reach a real install.
# Stops only the processes it started (Windows PIDs in its pid file, checked to still be
# electron.exe), never other processes by name or command line.
cd "$(dirname "$0")/.." || exit 1
fake=0 stop=0 profile=
while [ $# -gt 0 ]; do
  case "$1" in
    --fake) fake=1 ;;
    --stop) stop=1 ;;
    --profile) profile="$2"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
win() { cygpath -w "$1"; }
if [ -n "$profile" ]; then
  mkdir -p "$profile/Roaming/Familiar" "$profile/Local" "$profile/wow/_forever_/Interface/AddOns" || exit 1
  profile="$(cd "$profile" && pwd)"
  export APPDATA="$(win "$profile/Roaming")" LOCALAPPDATA="$(win "$profile/Local")"
  piddir="$profile"
  udata=("--user-data-dir=$(win "$profile/electron-companion")")
  fdata=("--user-data-dir=$(win "$profile/electron-fakewow")")
  wow="$profile/wow"
  [ -f "$wow/.build.info" ] || printf 'Branch!STRING:0|Version!STRING:0|Product!STRING:0\nus|1.60.1.70755|wowf\n' >"$wow/.build.info"
  [ -f "$wow/_forever_/.flavor.info" ] || printf 'Product Flavor!STRING:0\nwowf\n' >"$wow/_forever_/.flavor.info"
  cfg="$profile/Roaming/Familiar/config.json"
  # No Windows notices or cues from a test run on someone's desktop.
  [ -f "$cfg" ] || WOW="$(win "$wow")" node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ wowRoot: process.env.WOW, wowFlavor: "_forever_", launchAtLogin: false, trayNotices: false, sound: false }, null, 2))' "$(win "$cfg")"
else
  piddir="$(cygpath -u "${TEMP:-/tmp}")"
  udata=() fdata=()
fi
pidfile() { echo "$piddir/familiar-dev-restart-$1.pid"; }

stop_one() { # name: taskkill the recorded PID's tree, if it is still an electron.exe
  local f pid
  f="$(pidfile "$1")"
  [ -f "$f" ] || return 0
  pid="$(cat "$f")"
  rm -f "$f"
  if tasklist //FI "PID eq $pid" //FO CSV //NH 2>/dev/null | grep -qi '^"electron\.exe"'; then
    taskkill //T //F //PID "$pid" >/dev/null 2>&1 && echo "stopped $1 (PID $pid)"
  fi
}

start_one() { # name exe args...: start detached and record the Windows PID
  local name="$1"
  shift
  (FAMILIAR_DEV=1 "$@" >/dev/null 2>&1 &
    p=$!
    for _ in 1 2 3 4 5 6 7 8 9 10; do [ -r "/proc/$p/winpid" ] && break; sleep 0.1; done
    cat "/proc/$p/winpid" >"$(pidfile "$name")")
  echo "started $name (PID $(cat "$(pidfile "$name")"))"
}

ELECTRON=node_modules/electron/dist/electron.exe
[ -x "$ELECTRON" ] || { echo "missing $ELECTRON: run node node_modules/electron/install.js" >&2; exit 1; }
stop_one companion
if [ "$fake" = 1 ] || [ "$stop" = 1 ]; then stop_one fakewow; fi
[ "$stop" = 1 ] && exit 0

if [ "$fake" = 1 ]; then
  start_one fakewow "$ELECTRON" dist/fakewow-main.js --minutes 30 "${fdata[@]}"
  sleep 3
fi
log="$APPDATA/Familiar/familiar.log"
from=1
[ -f "$log" ] && from=$(($(wc -l <"$log") + 1))
FAMILIAR_TARGET_TITLE=FakeWoW FAMILIAR_CAPTURE=${FAMILIAR_CAPTURE:-window} start_one companion "$ELECTRON" . --background "${udata[@]}"
sleep 8
tail -n +"$from" "$log" 2>/dev/null | tail -5 | cut -c1-200
