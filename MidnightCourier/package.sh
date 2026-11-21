#!/bin/sh
# Cook, stage and archive a standalone Mac app: ../Release/Midnight-Courier-macOS.zip
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
ENGINE="${UE_ENGINE_DIR:-$HOME/UnrealEngine}"
CONFIG="${1:-Shipping}"
case "$CONFIG" in Shipping|Development) ;; *) echo 'Use Shipping or Development.' >&2; exit 2;; esac
"$DIR/Scripts/dev.sh" build
"$ENGINE/Engine/Build/BatchFiles/RunUAT.sh" -WaitForUATMutex BuildCookRun \
  -project="$DIR/MidnightCourier.uproject" -platform=Mac -clientconfig="$CONFIG" \
  -ubtargs=-WaitMutex -build -cook -stage -pak -map=/Engine/Maps/Entry -nocompileeditor -nop4 -utf8output -unattended
APP="$DIR/Saved/StagedBuilds/Mac/MidnightCourier.app"
if [ "$CONFIG" = Shipping ]; then APP="$DIR/Saved/StagedBuilds/Mac/MidnightCourier-Mac-Shipping.app"; fi
test -d "$APP/Contents/UE/MidnightCourier/Content/Paks"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
RELEASE="$DIR/../Release"
mkdir -p "$RELEASE"
WORK="$(mktemp -d "$DIR/Saved/package.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
BUNDLE="$WORK/Midnight Courier"
mkdir -p "$BUNDLE/Fonts"
ditto "$APP" "$BUNDLE/Midnight Courier.app"
cp "$DIR/Build/Distribution/PLAY FIRST.txt" "$BUNDLE/"
cp "$DIR"/Content/Courier/Fonts/OFL-*.txt "$BUNDLE/Fonts/"
ditto -c -k --sequesterRsrc --keepParent "$BUNDLE" "$WORK/build.zip"
ZIP="Midnight-Courier-macOS.zip"
if [ "$CONFIG" != Shipping ]; then ZIP="Midnight-Courier-macOS-$CONFIG.zip"; fi
mv "$WORK/build.zip" "$RELEASE/$ZIP"
(cd "$RELEASE" && shasum -a 256 "$ZIP" > "$ZIP.sha256")
echo "$RELEASE/$ZIP"
