// Midnight Courier — browser edition. Boot: load assets, build the world, run the game loop.
// URL flags (tests / dev): ?auto=main|short (autopilot rides a route), ?ride (skip the title), ?fresh (ignore
// the saved best), ?noghost, ?invincible, ?mute, ?quality=0..3, ?fps (show FPS), ?nohud,
// ?tele=x,y,z,yaw (start elsewhere: Unreal cm and degrees, like -McTele).
import * as THREE from 'three';
import { World } from './world.js';
import { Renderer, QUALITY } from './render.js';
import { Settings } from './settings.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Hud } from './hud.js';
import { Game } from './game.js';
import { shared } from './materials.js';

const q = new URLSearchParams(location.search);
const params = {
	auto: q.get('auto'), ride: q.has('ride'), fresh: q.has('fresh') || q.has('auto'), noghost: q.has('noghost'),
	invincible: q.has('invincible'), nohud: q.has('nohud'), tele: q.get('tele'),
};

const fill = document.getElementById('ld-fill');
const ltext = document.getElementById('ld-text');
const progress = (f) => { fill.style.width = `${Math.round(f * 100)}%`; };

async function boot() {
	const probe = document.createElement('canvas').getContext('webgl2');
	if (!probe) throw new Error('this browser has no WebGL 2 (try a current Chrome, Safari, Firefox or Edge).');
	const settings = new Settings();
	if (q.has('quality')) { settings.quality = Math.max(0, Math.min(3, Number(q.get('quality')) | 0)); settings.applyPreset(); }
	if (q.has('fps')) settings.showFps = true;
	const canvas = document.getElementById('view');
	const renderer = new Renderer(canvas);
	const scene = new THREE.Scene();
	const world = new World(scene);
	const audio = new Audio(settings);
	const fontsReady = Promise.all(['400 20px Anton', '500 20px "Barlow Condensed"', '600 20px "Barlow Condensed"', '700 20px "Barlow Condensed"',
		'italic 700 20px "Barlow Condensed"', 'italic 800 20px "Barlow Condensed"'].map((f) => document.fonts.load(f))).catch(() => {});
	const audioReady = audio.load().catch((e) => console.warn('audio disabled', e));
	await world.load(progress);
	ltext.textContent = 'building the city…';
	progress(0.98);
	await fontsReady;

	const input = new Input();
	const hud = new Hud(document.getElementById('hud'), document.getElementById('hudlines'));
	if (params.nohud) { document.getElementById('hud').style.display = 'none'; document.getElementById('hudlines').style.display = 'none'; }
	const game = new Game({ world, renderer, audio, hud, settings, input, params });

	const applyGraphics = () => {
		const Q = QUALITY[settings.quality];
		renderer.setQuality(Q, { shadows: settings.shadows, refl: settings.refl, effects: settings.effects });
		world.setLightPool(Q.points, Q.spots);
		const head = game.bikeView.lights.head;
		head.castShadow = settings.shadows;
		head.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
		if (head.shadow.map) { head.shadow.map.dispose(); head.shadow.map = null; }
		renderer.resize(settings.resScale);
	};
	game.onGraphics = applyGraphics;
	applyGraphics();
	window.addEventListener('resize', () => renderer.resize(settings.resScale));

	input.onFirstGesture = () => { audioReady.then(() => { audio.resume(); game.audioReady = true; }); };
	audioReady.then(() => { if (audio.ctx && audio.ctx.state === 'running') game.audioReady = true; });

	// Compile shaders up front so the first frames don't hitch.
	const camDir = new THREE.Vector3();
	game.tick(0.016);
	renderer.setCamera(game.bike.camLoc, game.bike.camRot, game.bike.camFovOut);
	renderer.camera.getWorldDirection(camDir);
	world.updateLights(renderer.camera.position, camDir, true);
	try { await renderer.gl.compileAsync(scene, renderer.camera); } catch { /* older three */ }

	document.getElementById('loading').classList.add('done');
	setTimeout(() => document.getElementById('loading').remove(), 800);

	// Cursor hides while playing with keys/pad.
	let mouseT = 0;
	window.addEventListener('mousemove', () => { mouseT = performance.now(); });

	const perf = { frames: 0, time: 0, worst: 0, log: [], sim: 0, gfx: 0, hud: 0, cpuWorst: 0 };
	let last = performance.now();
	const frame = (now) => {
		requestAnimationFrame(frame);
		const raw = Math.max(0.0001, (now - last) / 1000);
		last = now;
		const c0 = performance.now();
		game.tick(raw);
		const c1 = performance.now();
		const B = game.bike;
		renderer.setCamera(B.camLoc, B.camRot, B.camFovOut);
		renderer.camera.getWorldDirection(camDir);
		world.updateLights(renderer.camera.position, camDir);
		// Spray puffs are points: size in pixels = metres x focal length.
		game.bikeView.spray.material.uniforms.uScale.value = renderer.h / (2 * Math.tan(renderer.camera.fov * Math.PI / 360));
		world.tick(Math.min(raw, 0.05), game.time);
		shared.uTime.value = game.time;
		renderer.time = game.time;
		renderer.lightningEv = world.lightning * 0.8;
		const head = game.bikeView.lights.head;
		const lampPos = B.getHeadLampLocation(), lampDir = B.getHeadLampDirection();
		const rp = game.renderParams();
		rp.halos = world.haloLights;
		rp.lamp = { pos: new THREE.Vector3(lampPos.x, lampPos.z, lampPos.y), dir: new THREE.Vector3(lampDir.x, lampDir.z, lampDir.y), intensity: B.crashed ? 0 : head.intensity };
		renderer.render(scene, rp);
		const c2 = performance.now();
		hud.draw(game, Math.min(raw, 0.05));
		const c3 = performance.now();
		perf.sim += c1 - c0; perf.gfx += c2 - c1; perf.hud += c3 - c2; perf.cpuWorst = Math.max(perf.cpuWorst, c3 - c0);
		document.getElementById('hud').classList.toggle('nocursor', now - mouseT > 2500 && game.phase !== 'title' && !game.paused && !game.settingsOpen);

		// Perf log (MC_PERF like the Unreal build) + test hooks.
		perf.frames++; perf.time += raw; perf.worst = Math.max(perf.worst, raw);
		if (perf.time >= 5) {
			const f = perf.frames;
			const line = `MC_PERF fps=${(f / perf.time).toFixed(1)} worst=${(perf.worst * 1000).toFixed(1)}ms res=${renderer.w}x${renderer.h} cpu: sim=${(perf.sim / f).toFixed(2)} render=${(perf.gfx / f).toFixed(2)} hud=${(perf.hud / f).toFixed(2)} worst=${perf.cpuWorst.toFixed(1)}ms`;
			console.log(line);
			perf.log.push(f / perf.time);
			perf.frames = 0; perf.time = 0; perf.worst = 0; perf.sim = 0; perf.gfx = 0; perf.hud = 0; perf.cpuWorst = 0;
		}
		window.__mc = {
			phase: game.phase, runTime: game.runTime, condition: B.condition, result: game.result, fps: game.measuredFps,
			perf: perf.log, pos: [B.px, B.py, B.pz], speed: B.getSpeed(), checkpoint: game.nextCheckpoint, res: [renderer.w, renderer.h],
			crashes: game.result.crashes, info: renderer.gl.info.render,
		};
	};
	requestAnimationFrame(frame);
	window.__game = game;
}

boot().catch((e) => {
	console.error(e);
	ltext.textContent = `Could not start: ${e.message}`;
	ltext.classList.add('err');
});
