# Midnight Courier — browser edition

A three.js port of the Unreal game in [`MidnightCourier/`](../../MidnightCourier/README.md): the same city,
the same hand-rolled bike physics (fixed 240 Hz, constants from `McBike.cpp`'s `Tune`), the same rider rig,
scoring, ghost, autopilot, HUD and sounds. Plain ES modules, no build step.

## Run

    cd web && python3 -m http.server 8000      # then open http://localhost:8000/play/

Any static server works. WebGL 2 is required (current Chrome, Safari, Firefox, Edge).

Controls are the Unreal ones: W/S pedal and brake (tilt in the air), A/D steer, hold Space to brace and
release to hop, Shift to power-slide, R to restart, G to toggle the ghost, Esc/P to pause. Gamepads work with
the standard mapping. Menus also take the mouse.

URL flags: `?auto=main` / `?auto=short` (autopilot rides a route from `level.json`), `?ride` (skip the
title), `?fresh` (ignore the saved best), `?noghost`, `?invincible`, `?mute`, `?quality=0..3`, `?fps`,
`?nohud`, `?tele=x,y,z,yaw` (start elsewhere, Unreal centimetres like `-McTele`). Settings and the best run (with its ghost) are kept in `localStorage`.

## Layout

    index.html, css/hud.css     page, importmap, HUD styles (fonts from the Unreal project, OFL)
    src/main.js                 boot, frame loop, perf log (MC_PERF lines in the console every 5 s)
    src/bike.js                 port of AMcBike: physics, damage, rider IK posing, chase camera, spray
    src/collision.js            sphere / capsule sweeps and line traces against the solid chunks (three-mesh-bvh)
    src/game.js                 port of AMcGameMode: run flow, input, autopilot, scoring, checkpoints, ghost
    src/hud.js                  port of AMcHud as an immediate-mode DOM layer + a canvas for lines
    src/world.js                level.json, city batches, light pool, rain, sky, beacon, lightning, bike views
    src/materials.js            GLSL ports of the procedural HLSL materials in Scripts/import_assets.py
    src/render.js               HDR pipeline: planar wet reflection, fog glow, bloom, grade, tone curve
    src/audio.js, settings.js, input.js, math.js
    assets/                     built by tools/build_assets.sh (do not edit)
    vendor/                     three r187 + addons, three-mesh-bvh (copied by tools/build_assets.sh)

The simulation works in Unreal's frame (X forward, Y right, Z up) in metres; only rendering converts to
three.js space with `three = (ue.x, ue.z, ue.y)` (a mirror, so rotations become `M R M`).

## Rebuilding the assets

    web/play/tools/build_assets.sh

Reads `MidnightCourier/Art/Export/web/*.glb`, `Art/Export/level.json`, `Art/Audio/*.wav` and the fonts, and
writes `assets/` and `vendor/` (installs its npm tools into `tools/node_modules` on first run; needs node and
ffmpeg). Meshes are packed into four files (`city_s.glb` solid chunks, `city_d.glb` decoration, `props.glb`,
`rider.glb`), stripped to the vertex attributes each material reads, quantized and meshopt-compressed.
Loops are encoded with a copy of their tail and head around them and played as a one-period window, so they
loop seamlessly whatever the MP3 decoder does with its priming samples. Re-run it after the Blender exports
change. Total download is about 15 MB.

## Tests and screenshots

    cd web/play/tools && npm install          # once (playwright-core, gltf-transform, three)
    node shot.mjs                             # everything, headless Chrome
    node shot.mjs main --headed               # one ride in a visible window (real frame rate)

`shot.mjs` serves `web/` itself, drives the installed Google Chrome, and writes `tools/shots/*.png` plus
`summary.json`: title, settings, pause, five aspect ratios (with a HUD overlap check on glyph boxes),
the four quality presets, `?auto=main` (must deliver; then a second run with the ghost) and `?auto=short`.
It fails on console errors. The main route delivers in about 96 s with ~98% condition (Unreal: 1:36.25, 99%).
The short-route autopilot breaks the package around 75 s, exactly as it does in Unreal.

## Differences from the Unreal version

- Lighting: three.js can't run ~230 dynamic lights with Lumen GI, so the nearest 10–20 level lights (by
  quality) are real lights, re-picked every few frames with a distance fade; the rest is emissive surfaces,
  analytic fog glow around the nearest 24 lights and the head-lamp beam, a hemisphere fill for Lumen's bounce,
  and bloom. Only the head lamp casts shadows.
- Reflections: a planar reflection of the ground plane under the bike (tilted to the slope), sampled by the
  wet materials with roughness-based blur, instead of Lumen/SSR. High and Ultra only.
- Volumetric and height fog become exponential fog plus the analytic glow; no motion blur or depth of field.
- Rain streaks are kept at least ~1 px wide (and dimmed to match) since there is no temporal AA.
- Rect lights are approximated as wide spot lights. The tone curve is an ACES fit, not Unreal's filmic curve.
- The title's QUIT item becomes FULL SCREEN; settings offer render scale, shadows, reflections and glow
  instead of Lumen/VSync/frame-cap options.
