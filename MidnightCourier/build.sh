#!/bin/sh
# Compile Midnight Courier. With --assets (or when content is missing) also rebuild every asset:
# Blender generates the bike, rider and the whole neighbourhood, numpy synthesizes the audio,
# then the Unreal editor builds the materials and imports everything.
set -e
ENGINE="${UE_ENGINE_DIR:-$HOME/UnrealEngine}"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
DIR="$(cd "$(dirname "$0")" && pwd)"
"$ENGINE/Engine/Build/BatchFiles/Mac/Build.sh" MidnightCourierEditor Mac Development -Project="$DIR/MidnightCourier.uproject" -WaitMutex
if [ "$1" = "--assets" ] || [ ! -f "$DIR/Content/Courier/Data/level.json" ]; then
  "$BLENDER" -b --factory-startup --python-exit-code 1 --python "$DIR/Art/build_bike.py"
  "$BLENDER" -b --factory-startup --python-exit-code 1 --python "$DIR/Art/build_city.py"
  # Blender ships a Python with numpy, which is all the synthesizer needs.
  PYTHON="$(ls "$(dirname "$BLENDER")"/../Resources/*/python/bin/python3* | head -1)"
  "$PYTHON" "$DIR/Scripts/make_audio.py"
  "$DIR/Scripts/dev.sh" py "$DIR/Scripts/import_assets.py"
fi
