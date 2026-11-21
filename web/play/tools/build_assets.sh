#!/usr/bin/env bash
# Rebuilds everything the browser game loads from the Unreal project's exports:
#   meshes  MidnightCourier/Art/Export/web/*.glb  -> web/play/assets/*.glb   (meshopt + quantized)
#   data    MidnightCourier/Art/Export/level.json -> web/play/assets/level.json
#   audio   MidnightCourier/Art/Audio/*.wav       -> web/play/assets/audio/*.mp3 (+ audio.json)
#   fonts   MidnightCourier/Content/Courier/Fonts -> web/play/fonts
#   vendor  three + addons + three-mesh-bvh       -> web/play/vendor
# Run from anywhere:  web/play/tools/build_assets.sh   (needs node/npm and ffmpeg)
set -euo pipefail
TOOLS="$(cd "$(dirname "$0")" && pwd)"
PLAY="$(cd "$TOOLS/.." && pwd)"
REPO="$(cd "$PLAY/../.." && pwd)"
MC="$REPO/MidnightCourier"
FFMPEG="${FFMPEG:-$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)}"

cd "$TOOLS"
if [ ! -d node_modules/@gltf-transform/functions ] || [ ! -d node_modules/three ]; then npm install --no-audit --no-fund; fi

echo "== meshes"
mkdir -p "$PLAY/assets"
node build_assets.mjs "$MC/Art/Export/web" "$PLAY/assets"

echo "== level data"
python3 -c "import json,sys; json.dump(json.load(open(sys.argv[1])), open(sys.argv[2],'w'), separators=(',',':'))" \
	"$MC/Art/Export/level.json" "$PLAY/assets/level.json"

echo "== audio"
AUD="$PLAY/assets/audio"
rm -rf "$AUD"; mkdir -p "$AUD"
LOOPS=" A_RainLoop A_CityLoop A_WindLoop A_RollLoop A_FreewheelLoop A_ChainLoop A_SkidLoop A_MusicRide A_MusicTitle "
PAD=0.25
MANIFEST="{"
for f in "$MC"/Art/Audio/*.wav; do
	n="$(basename "$f" .wav)"
	info="$("$FFMPEG" -hide_banner -i "$f" 2>&1 || true)"
	dur="$(echo "$info" | sed -n 's/.*Duration: \([0-9:.]*\).*/\1/p' | awk -F: '{print $1*3600+$2*60+$3}')"
	ch=1; if echo "$info" | grep -q stereo; then ch=2; fi
	br=$([ "$ch" = 2 ] && echo 160k || echo 96k)
	if [[ "$LOOPS" == *" $n "* ]]; then
		# Loops are encoded with a copy of their tail before and their head after, so the player can loop a
		# window of exactly one period that sits away from the encoder's priming/padding samples: seamless
		# in every browser whatever the decoder does with the MP3 delay.
		"$FFMPEG" -v error -y -i "$f" -filter_complex \
			"[0:a]asplit=3[a][b][c];[a]atrim=start=$(awk "BEGIN{print $dur-$PAD}"),asetpts=PTS-STARTPTS[pre];[c]atrim=end=$PAD,asetpts=PTS-STARTPTS[post];[pre][b][post]concat=n=3:v=0:a=1[o]" \
			-map "[o]" -c:a libmp3lame -b:a "$br" "$AUD/$n.mp3"
		MANIFEST="$MANIFEST\"$n\":{\"dur\":$dur,\"loop\":true,\"pad\":$PAD},"
	else
		"$FFMPEG" -v error -y -i "$f" -c:a libmp3lame -b:a "$br" "$AUD/$n.mp3"
		MANIFEST="$MANIFEST\"$n\":{\"dur\":$dur,\"loop\":false,\"pad\":0},"
	fi
done
echo "${MANIFEST%,}}" > "$AUD/audio.json"
du -sh "$AUD"

echo "== fonts"
mkdir -p "$PLAY/fonts"
cp "$MC"/Content/Courier/Fonts/*.ttf "$MC"/Content/Courier/Fonts/OFL-*.txt "$PLAY/fonts/"

echo "== vendor"
V="$PLAY/vendor"
rm -rf "$V"; mkdir -p "$V/three/addons/loaders" "$V/three/addons/utils" "$V/three/addons/libs" "$V/three-mesh-bvh"
T="$TOOLS/node_modules/three"
cp "$T/build/three.module.js" "$T/build/three.core.js" "$T/LICENSE" "$V/three/"
cp "$T/examples/jsm/loaders/GLTFLoader.js" "$V/three/addons/loaders/"
cp "$T/examples/jsm/utils/BufferGeometryUtils.js" "$T/examples/jsm/utils/SkeletonUtils.js" "$V/three/addons/utils/"
cp "$T/examples/jsm/libs/meshopt_decoder.module.js" "$V/three/addons/libs/"
cp "$TOOLS/node_modules/three-mesh-bvh/build/index.module.js" "$V/three-mesh-bvh/"
cp "$TOOLS/node_modules/three-mesh-bvh/LICENSE" "$V/three-mesh-bvh/"
echo "three $(node -p "require('$T/package.json').version"), three-mesh-bvh $(node -p "require('$TOOLS/node_modules/three-mesh-bvh/package.json').version")"

echo "== total"
du -sh "$PLAY/assets" "$PLAY/vendor" "$PLAY/fonts"
