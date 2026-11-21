#!/bin/sh
# Developer helper. Usage:
#   Scripts/dev.sh build                 compile the game module
#   Scripts/dev.sh sync                  compile only if the module is missing or out of step with the engine
#   Scripts/dev.sh py <script.py> [...]  run an editor-Python script headlessly (asset building)
#   Scripts/dev.sh game [args...]        run the game in a window and wait for it to exit
#                                        (log: Saved/Logs/game.log, or Saved/Logs/$MC_LOG.log)
#
# The source-built engine at ~/UnrealEngine is shared with other projects. When one of them relinks an
# engine module the engine's build id changes and this module's manifest goes stale ("module could not be
# found"), so `sync` runs before anything that launches the editor binary.
set -e
ENGINE="${UE_ENGINE_DIR:-$HOME/UnrealEngine}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$DIR/MidnightCourier.uproject"
EDITOR="$ENGINE/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor"

build() {
  "$ENGINE/Engine/Build/BatchFiles/Mac/Build.sh" MidnightCourierEditor Mac Development -Project="$PROJECT" -WaitMutex
}

build_id() { sed -n 's/.*"BuildId": "\(.*\)".*/\1/p' "$1" 2>/dev/null; }

in_sync() {
  [ -f "$DIR/Binaries/Mac/libUnrealEditor-MidnightCourier.dylib" ] || return 1
  [ "$(build_id "$DIR/Binaries/Mac/UnrealEditor.modules")" = "$(build_id "$ENGINE/Engine/Binaries/Mac/UnrealEditor.modules")" ] || return 1
  [ -z "$(find "$DIR/Source" -newer "$DIR/Binaries/Mac/libUnrealEditor-MidnightCourier.dylib" -type f | head -1)" ]
}

sync() { in_sync || build >"$DIR/Saved/build.log" 2>&1 || { grep -E "error|Error" "$DIR/Saved/build.log" | head -40; tail -5 "$DIR/Saved/build.log"; exit 1; }; }

mkdir -p "$DIR/Saved/Logs"
CMD="$1"; [ $# -gt 0 ] && shift
case "$CMD" in
  build) build ;;
  sync) sync ;;
  py)
    sync
    SCRIPT="$1"; shift
    rc=0
    "$EDITOR" "$PROJECT" -run=pythonscript -script="$SCRIPT" -unattended -nopause -nosplash -AllowCommandletRendering -stdout -FullStdOutLogOutput "$@" >"$DIR/Saved/Logs/py.log" 2>&1 || rc=$?
    grep -E "MC_|Traceback|LogPython: Error|could not be found" "$DIR/Saved/Logs/py.log" | cut -c1-400 || true
    [ "$rc" -eq 0 ] || exit "$rc"
    if grep -q "LogPython: Error:" "$DIR/Saved/Logs/py.log"; then exit 1; fi
    ;;
  game)
    sync
    SIZE="-ResX=1600 -ResY=900"
    case " $* " in *" -ResX="*) SIZE="" ;; esac
    "$EDITOR" "$PROJECT" -game -windowed $SIZE -nosplash -unattended -stdout -FullStdOutLogOutput "$@" >"$DIR/Saved/Logs/${MC_LOG:-game}.log" 2>&1 || true
    ;;
  *) echo "usage: dev.sh build|sync|py <script>|game [args]"; exit 2 ;;
esac
