#!/bin/sh
# Launch Midnight Courier using the source-built Unreal editor binary. Extra arguments pass through,
# e.g.  ./play.sh -ResX=2560 -ResY=1440
ENGINE="${UE_ENGINE_DIR:-$HOME/UnrealEngine}"
DIR="$(cd "$(dirname "$0")" && pwd)"
"$DIR/Scripts/dev.sh" sync   # recompiles only if the module is missing or out of step with the engine
SIZE="-ResX=1600 -ResY=900"
case " $* " in *" -ResX="*) SIZE="" ;; esac
open -n "$ENGINE/Engine/Binaries/Mac/UnrealEditor.app" --args "$DIR/MidnightCourier.uproject" -game "$@" -windowed $SIZE
