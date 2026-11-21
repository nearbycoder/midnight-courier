// Run flow: a port of AMcGameMode (McGame.cpp) — title, countdown, riding, respawn, delivered, failed;
// input (keyboard + gamepad), scoring and grades, checkpoints and splits, the ghost of the best run
// (localStorage), the autopilot used by tests (?auto=main / ?auto=short) and the cameras for menus.
import * as THREE from 'three';
import { Bike, Tune } from './bike.js';
import { updateSprayView } from './world.js';
import { buildSettingsRows } from './settings.js';
import { C as COL } from './hud.js';
import {
	clamp, lerp, sign, finterp, deltaAngleDeg, smoothStep, rotatorVector, vectorRotation, DEG,
} from './math.js';

const SAVE_KEY = 'midnight-courier.best.v3';
const ColGood = COL.Good, ColGold = COL.Gold, ColBad = COL.Bad, ColWarn = COL.Warn, ColInfo = COL.Info;

function emptyResult() {
	return { time: 0, condition: 0, tip: 0, timeBonus: 0, careMultiplier: 1, pristineBonus: 0, grade: '', landings: 0, perfectLandings: 0, crashes: 0, airTime: 0, topSpeed: 0 };
}
function rotLerp(a, b, t) {
	return { pitch: a.pitch + deltaAngleDeg(a.pitch, b.pitch) * t, yaw: a.yaw + deltaAngleDeg(a.yaw, b.yaw) * t, roll: a.roll + deltaAngleDeg(a.roll, b.roll) * t };
}

export class Game {
	constructor({ world, renderer, audio, hud, settings, input, params }) {
		this.world = world; this.renderer = renderer; this.audio = audio; this.hud = hud; this.settings = settings; this.input = input;
		this.params = params;
		this.phase = 'title';
		this.fail = null;
		this.phaseTime = 0; this.runTime = 0; this.timeLimit = 120;
		this.nextCheckpoint = 0;
		this.splits = []; this.bestSplits = [];
		this.lastSplitDelta = 0; this.lastSplitAge = 100; this.lastSplitName = '';
		this.callouts = [];
		this.result = emptyResult(); this.best = emptyResult();
		this.hasBest = false; this.newBest = false;
		this.paused = false; this.pauseIndex = 0; this.titleIndex = 0;
		this.settingsOpen = false; this.settingsIndex = 0; this.settingsRows = [];
		this.measuredFps = 60;
		this.runCount = 0;
		this.damageFlash = 0; this.lastDamage = 0; this.cleanStreak = 0;
		this.ghostEnabled = settings.ghost;
		this.distanceToGoal = 0; this.goalBearing = 0;
		this.fade = 1;
		this.prompt = '';
		this.recording = []; this.bestGhost = []; this.recordAccum = 0;
		this.safePoints = []; this.safeAccum = 0; this.groundedFor = 0; this.respawnAt = null;
		this.prev = {};
		this.repeatTimer = 0;
		this.autopilot = !!params.auto; this.autoRoute = params.auto || 'main'; this.autoIndex = 0; this.autoHopTimer = 0;
		this.titleOrbit = 0;
		this.resultCamFrom = new THREE.Vector3(); this.resultCamRotFrom = { pitch: 0, yaw: 0, roll: 0 }; this.resultOrbitYaw = 0;
		this.time = 0;
		this.audioReady = false;
		this.reflNormal = new THREE.Vector3(0, 1, 0);
		this.reflPoint = new THREE.Vector3();

		if (params.tele) {
			const t = params.tele.split(',').map(Number);
			if (t.length >= 4 && t.every(Number.isFinite)) { world.startPos.set(t[0] / 100, t[1] / 100, t[2] / 100); world.startYaw = t[3]; }
		}
		const env = { collision: world.collision, water: world.water, settings, time: () => this.time };
		this.bikeView = world.buildBikeView();
		this.ghostView = world.buildBikeView({ ghost: true });
		this.bike = new Bike(env, this.bikeView);
		this.ghost = new Bike(env, this.ghostView, { ghost: true });
		this.ghostView.root.visible = false;
		this.bike.invincible = !!params.invincible;
		if (params.noghost) this.ghostEnabled = false;
		if (!params.fresh) this.loadBest();

		this.bike.resetTo(world.startPos, world.startYaw, 0);
		this.bike.setFrozen(true);
		this.bike.snapCamera();
		if (this.autopilot || params.ride) this.restart();
		else this.enterPhase('title');

		hud.onAction = (a) => this.menuAction(a);
		hud.onHover = (a) => this.menuHover(a);
	}

	get cameraYaw() { return this.bike.camRot.yaw; }
	isGhostVisible() { return this.ghostView.root.visible; }

	// ---- settings screen ---------------------------------------------------------------------------------
	openSettings() {
		this.settingsOpen = true;
		this.settingsIndex = 0;
		this.settingsRows = buildSettingsRows(this.settings, {
			onGraphics: () => this.onGraphics && this.onGraphics(),
			onBack: () => this.closeSettings(),
			isFullscreen: () => !!document.fullscreenElement,
			toggleFullscreen: () => this.toggleFullscreen(),
			autoScale: () => Math.round(this.renderer.scale / (window.devicePixelRatio || 1) * 100),
		});
	}
	closeSettings() {
		this.settingsOpen = false;
		this.settingsRows = [];
		this.ghostEnabled = this.settings.ghost;
		this.settings.save();
	}
	toggleFullscreen() {
		if (document.fullscreenElement) document.exitFullscreen?.();
		else document.documentElement.requestFullscreen?.().catch(() => {});
	}

	rumble(strength, duration) {
		if (!this.settings.rumble || this.autopilot) return;
		this.input.rumble(clamp(strength, 0, 1), duration);
	}

	enterPhase(p) {
		this.phase = p;
		this.phaseTime = 0;
		this.audio.onPhase(p);
	}

	restart() {
		const W = this.world, B = this.bike;
		this.runCount++;
		B.resetTo(W.startPos, W.startYaw, 0);
		B.condition = 100;
		B.setFrozen(true);
		B.snapCamera();
		this.runTime = 0;
		this.nextCheckpoint = 0;
		this.splits = [];
		this.callouts = [];
		this.recording = [];
		this.recordAccum = 0;
		this.safePoints = [];
		this.safeAccum = 0;
		this.groundedFor = 0;
		this.respawnAt = { pos: W.startPos.clone(), yaw: W.startYaw, time: 0, cp: 0 };
		this.result = emptyResult();
		this.fail = null;
		this.newBest = false;
		this.paused = false;
		this.lastSplitAge = 100;
		this.damageFlash = 0;
		this.cleanStreak = 0;
		this.autoIndex = 0;
		this.fade = 0;
		W.setGoalActive(true);
		this.ghostView.root.visible = this.ghostEnabled && this.bestGhost.length > 1;
		if (this.bestGhost.length > 0) { const g = this.bestGhost[0]; this.ghost.setPoseFromRecording(g.pos, g.rot, 0, 0, 0); }
		this.enterPhase('countdown');
		this.audio.onRestart();
	}

	addCallout(text, sub, color, size = 1, life = 1.6) {
		for (const c of this.callouts) if (c.text === text && c.age < 0.5) { c.sub = sub; c.age = 0; return; }
		this.callouts.unshift({ text, sub, color, size, life, age: 0 });
		if (this.callouts.length > 4) this.callouts.length = 4;
	}

	// ==================================================================================================
	// Input
	// ==================================================================================================
	readInput(dt) {
		const I = this.input;
		I.poll();
		const key = (c) => I.key(c);
		const In = { throttle: 0, brake: 0, steer: 0, lean: 0, brace: false, drift: false };
		const stickX = I.axis(0), stickY = -I.axis(1);
		let steer = ((key('KeyD') || key('ArrowRight')) ? 1 : 0) - ((key('KeyA') || key('ArrowLeft')) ? 1 : 0);
		if (Math.abs(stickX) > 0.12) steer = sign(stickX) * Math.pow((Math.abs(stickX) - 0.12) / 0.88, 2) * 0.6 + stickX * 0.4;
		In.steer = clamp(steer, -1, 1);
		const bW = key('KeyW') || key('ArrowUp'), bS = key('KeyS') || key('ArrowDown');
		In.throttle = Math.max(bW ? 1 : 0, I.btnValue(7));
		In.brake = Math.max(bS ? 1 : 0, I.btnValue(6));
		In.lean = (bW ? 1 : 0) - (bS ? 1 : 0);
		if (Math.abs(stickY) > 0.2) In.lean = -stickY;
		In.brace = key('Space') || I.btn(0);
		In.drift = key('ShiftLeft') || key('ShiftRight') || I.btn(2) || I.btn(5);
		let restart = key('KeyR') || I.btn(3) || key('Backspace');
		let confirm = key('Enter') || key('NumpadEnter') || key('Space') || I.btn(0) || I.btn(9);
		let pause = key('Escape') || key('KeyP') || I.btn(9);
		let up = bW || I.btn(12) || stickY > 0.6, down = bS || I.btn(13) || stickY < -0.6;
		const ghostKey = key('KeyG') || I.btn(8);
		let left = key('KeyA') || key('ArrowLeft') || I.btn(14) || stickX < -0.6;
		let right = key('KeyD') || key('ArrowRight') || I.btn(15) || stickX > 0.6;
		let back = key('Escape') || I.btn(1);
		if (this.pending) { // clicks from the HUD
			const p = this.pending; this.pending = null;
			if (p === 'confirm') confirm = true;
		}
		if (this.autopilot && this.phase === 'riding') this.updateAutopilot(In, dt);

		const P = this.prev;
		const edge = (n, v) => v && !P[n];
		const restartE = edge('restart', restart), confirmE = edge('confirm', confirm), pauseE = edge('pause', pause);
		const upE = edge('up', up), downE = edge('down', down), ghostE = edge('ghost', ghostKey);
		let leftE = edge('left', left), rightE = edge('right', right);
		let upR = upE, downR = downE;
		if (left || right || up || down) {
			this.repeatTimer += dt;
			if (this.repeatTimer > 0.4) {
				this.repeatTimer -= 0.09;
				leftE ||= left; rightE ||= right; upR ||= up; downR ||= down;
			}
		} else this.repeatTimer = 0;
		const backE = edge('back', back);
		Object.assign(P, { restart, confirm, pause, up, down, ghost: ghostKey, left, right, back });
		const A = this.audio;

		// Settings screen (from the title or the pause menu) takes all input while open.
		if (this.settingsOpen) {
			const rows = this.settingsRows;
			if (rows.length) {
				if (upR) { this.settingsIndex = (this.settingsIndex + rows.length - 1) % rows.length; A.ui('Move'); }
				if (downR) { this.settingsIndex = (this.settingsIndex + 1) % rows.length; A.ui('Move'); }
				const row = rows[this.settingsIndex];
				if (leftE && !row.action) { row.change(-1); A.ui('Move'); }
				if (rightE && !row.action) { row.change(1); A.ui('Move'); }
				if (confirmE) { row.change(0); A.ui('Select'); }
			}
			if (backE || pauseE) this.closeSettings();
			this.bike.input = { throttle: 0, brake: 0, steer: 0, lean: 0, brace: false, drift: false };
			return;
		}

		if (ghostE) {
			this.ghostEnabled = !this.ghostEnabled;
			this.settings.ghost = this.ghostEnabled;
			this.settings.save();
			this.ghostView.root.visible = this.ghostEnabled && this.bestGhost.length > 1 && (this.phase === 'riding' || this.phase === 'countdown');
			this.addCallout(this.ghostEnabled ? 'GHOST ON' : 'GHOST OFF', '', ColInfo, 0.7, 1.0);
		}

		if (this.paused) {
			if (pauseE) this.paused = false;
			if (upR) { this.pauseIndex = (this.pauseIndex + 3) % 4; A.ui('Move'); }
			if (downR) { this.pauseIndex = (this.pauseIndex + 1) % 4; A.ui('Move'); }
			if (backE && !pauseE) this.paused = false;
			if (confirmE) {
				A.ui('Select');
				if (this.pauseIndex === 0) this.paused = false;
				else if (this.pauseIndex === 1) this.restart();
				else if (this.pauseIndex === 2) this.openSettings();
				else { this.paused = false; this.enterPhase('title'); this.bike.setFrozen(true); this.fade = 0; this.titleIndex = 0; this.ghostView.root.visible = false; }
			}
			if (restartE) this.restart();
			this.bike.input = { throttle: 0, brake: 0, steer: 0, lean: 0, brace: false, drift: false };
			return;
		}

		switch (this.phase) {
			case 'title':
				if (upR) { this.titleIndex = (this.titleIndex + 2) % 3; A.ui('Move'); }
				if (downR) { this.titleIndex = (this.titleIndex + 1) % 3; A.ui('Move'); }
				if (restartE && this.phaseTime > 0.6) this.restart();
				else if (confirmE && this.phaseTime > 0.6) {
					A.ui('Select');
					if (this.titleIndex === 0) this.restart();
					else if (this.titleIndex === 1) this.openSettings();
					else this.toggleFullscreen();
				}
				break;
			case 'countdown': case 'riding': case 'respawning':
				if (restartE) { this.restart(); return; }
				if ((pauseE || backE) && !this.autopilot) { this.paused = true; this.pauseIndex = 0; A.ui('Pause'); }
				break;
			case 'delivered': case 'failed':
				if (restartE || (confirmE && this.phaseTime > 1.2)) { this.restart(); return; }
				if (pauseE || backE) { this.enterPhase('title'); this.titleIndex = 0; }
				break;
		}
		this.bike.input = this.phase === 'riding' ? In : { throttle: 0, brake: 0, steer: 0, lean: 0, brace: false, drift: false };
	}

	/** Mouse / touch on HUD menu items. */
	menuAction(a) {
		const [kind, i, k] = a.split(':');
		const n = Number(i);
		if (kind === 'title' && this.phase === 'title' && !this.settingsOpen) { this.titleIndex = n; if (this.phaseTime > 0.6) this.pending = 'confirm'; }
		else if (kind === 'pause' && this.paused && !this.settingsOpen) { this.pauseIndex = n; this.pending = 'confirm'; }
		else if (kind === 'set' && this.settingsOpen) {
			this.settingsIndex = n;
			const row = this.settingsRows[n];
			if (row) { row.change(k === '0' ? 0 : 1); this.audio.ui(row.action ? 'Select' : 'Move'); }
		} else if (kind === 'again' && (this.phase === 'delivered' || this.phase === 'failed')) this.restart();
	}
	menuHover(a) {
		const [kind, i] = a.split(':');
		const n = Number(i);
		if (kind === 'title' && this.titleIndex !== n && !this.settingsOpen) { this.titleIndex = n; this.audio.ui('Move'); }
		else if (kind === 'pause' && this.pauseIndex !== n && !this.settingsOpen) { this.pauseIndex = n; this.audio.ui('Move'); }
		else if (kind === 'set' && this.settingsIndex !== n) { this.settingsIndex = n; this.audio.ui('Move'); }
	}

	updateAutopilot(In, dt) {
		const R = this.world.routes[this.autoRoute];
		if (!R || R.length < 2) return;
		const B = this.bike;
		const P = B.getWorldLocation();
		while (this.autoIndex < R.length - 1) {
			const a = R[this.autoIndex].pos, b = R[this.autoIndex + 1].pos;
			const abx = b.x - a.x, aby = b.y - a.y, apx = P.x - a.x, apy = P.y - a.y;
			const t = (apx * abx + apy * aby) / Math.max(1e-4, abx * abx + aby * aby);
			if (t > 1) this.autoIndex++; else break;
		}
		const I = Math.min(this.autoIndex, R.length - 2);
		const speed = B.getSpeed();
		const ahead = Math.max(3.5, speed * 0.55);
		let target = R[I + 1].pos.clone();
		{
			const a = R[I].pos, b = R[I + 1].pos;
			const abx = b.x - a.x, aby = b.y - a.y, len = Math.hypot(abx, aby);
			const t = clamp(((P.x - a.x) * abx + (P.y - a.y) * aby) / Math.max(1e-4, len * len), 0, 1);
			let remaining = ahead, seg = I, segT = t;
			while (seg < R.length - 1) {
				const sa = R[seg].pos, sb = R[seg + 1].pos;
				const sl = Math.hypot(sb.x - sa.x, sb.y - sa.y);
				const left = sl * (1 - segT);
				if (remaining <= left) { target = sa.clone().lerp(sb, segT + remaining / Math.max(sl, 0.01)); break; }
				remaining -= left;
				seg++; segT = 0;
				target = sb.clone();
			}
		}
		const wantYaw = Math.atan2(target.y - P.y, target.x - P.x) / DEG;
		const err = deltaAngleDeg(B.getYawDeg(), wantYaw);
		In.steer = clamp(err / 22, -1, 1);
		const next = R[Math.min(I + 1, R.length - 1)], cur = R[I];
		const distNext = Math.hypot(next.pos.x - P.x, next.pos.y - P.y);
		const anticipate = Math.sqrt(next.speed * next.speed + 2 * 5.5 * distNext);
		const want = Math.min(cur.speed, anticipate);
		In.throttle = speed < want - 0.3 ? 1 : 0;
		In.brake = speed > want + 0.6 ? clamp((speed - want) / 3, 0.2, 1) : 0;
		In.lean = 0;
		In.brace = cur.brace || (!B.grounded && B.airTime > 0.25);
		In.drift = false;
		if (this.autoHopTimer > 0) {
			this.autoHopTimer -= dt;
			In.brace = this.autoHopTimer > 0.06;
		} else if (next.hop && distNext < Math.max(1.5, speed * 0.12)) {
			this.autoHopTimer = 0.32;
			In.brace = true;
		}
	}

	// ==================================================================================================
	// Frame
	// ==================================================================================================
	tick(rawDt) {
		const dt = Math.min(rawDt, 0.05);
		this.time += rawDt;
		this.readInput(dt);
		this.measuredFps = lerp(this.measuredFps, 1 / Math.max(rawDt, 1e-4), Math.min(1, rawDt * 3));
		const B = this.bike, W = this.world;
		if (this.paused || this.settingsOpen) {
			B.setFrozen(true);
			B.tick(dt);
			this.audio.update(dt, this);
			return;
		}
		if (this.phase === 'riding') B.setFrozen(false);
		this.phaseTime += dt;
		for (const c of this.callouts) c.age += dt;
		this.callouts = this.callouts.filter((c) => c.age <= c.life);
		this.lastSplitAge += dt;
		this.damageFlash = Math.max(0, this.damageFlash - dt * 2.5);

		switch (this.phase) {
			case 'title':
				B.setFrozen(true);
				this.fade = Math.max(0, this.fade - dt * 0.8);
				this.updateTitleCamera(dt);
				break;
			case 'countdown':
				B.setFrozen(true);
				this.fade = Math.max(0, this.fade - dt * 4);
				if (this.phaseTime >= 1.5) { B.setFrozen(false); this.enterPhase('riding'); }
				break;
			case 'riding':
				this.updateRiding(dt);
				break;
			case 'respawning':
				this.runTime += dt;
				if (this.phaseTime > 1.3 && this.phaseTime - dt <= 1.3) this.respawn();
				this.fade = this.phaseTime < 1.0 ? clamp((this.phaseTime - 0.7) / 0.3, 0, 1) : clamp(1 - (this.phaseTime - 1.3) / 0.35, 0, 1);
				if (this.phaseTime > 1.7) { this.fade = 0; this.enterPhase('riding'); }
				break;
			case 'delivered': case 'failed': {
				B.input = { throttle: 0, brake: 1, steer: 0, lean: 0, brace: false, drift: false };
				if (this.phaseTime < dt * 1.5) {
					this.resultCamFrom.copy(B.camLoc);
					this.resultCamRotFrom = { ...B.camRot };
					this.resultOrbitYaw = B.camRot.yaw;
				}
				this.resultOrbitYaw += dt * 9;
				const c = (B.crashed ? B.getPackageWorldLocation() : B.getWorldLocation()).add(new THREE.Vector3(0, 0, 1.1));
				const ol = c.clone().addScaledVector(rotatorVector(-12, this.resultOrbitYaw), -4.3);
				const a = smoothStep(0, 1, clamp(this.phaseTime / 1.6, 0, 1));
				B.cameraOverride = true;
				B.overrideLoc.copy(this.resultCamFrom).lerp(ol, a);
				B.overrideRot = rotLerp(this.resultCamRotFrom, vectorRotation(c.clone().sub(B.overrideLoc)), a);
				B.overrideFov = lerp(80, 50, a);
				break;
			}
		}
		B.tick(dt);
		if (this.phase === 'riding' || this.phase === 'countdown' || this.phase === 'respawning') this.updateGhost(dt);
		this.ghost.tick(dt);
		updateSprayView(this.bikeView, B);

		// Where is the drop-off relative to the view?
		{
			const P = B.getWorldLocation();
			this.distanceToGoal = Math.hypot(W.goalPos.x - P.x, W.goalPos.y - P.y);
			const goalYaw = Math.atan2(W.goalPos.y - P.y, W.goalPos.x - P.x) / DEG;
			this.goalBearing = deltaAngleDeg(B.camRot.yaw, goalYaw);
		}
		W.setFocus(B.camLoc, B.getWorldVelocity());
		W.setLamp(B.getHeadLampLocation(), B.getHeadLampDirection());
		// Speed and damage push the grade a little.
		const sp = clamp((B.getSpeed() - 8) / 10, 0, 1);
		this.renderer.fringe = 0.3 + sp * 1.6 + this.damageFlash * 3;
		this.renderer.vignette = 0.5 + sp * 0.15 + this.damageFlash * 0.4;
		this.audio.update(dt, this);
		if (this.phase !== 'title' && this.phase !== 'delivered' && this.phase !== 'failed') B.cameraOverride = false;
	}

	updateRiding(dt) {
		const B = this.bike, W = this.world;
		this.runTime += dt;
		this.handleShocks();
		// Records for the ghost: 30 Hz.
		this.recordAccum += dt;
		if (this.recordAccum >= 1 / 30) {
			this.recordAccum -= 1 / 30;
			this.recording.push({ pos: B.getWorldLocation(), rot: { pitch: B.getPitchDeg(), yaw: B.getYawDeg(), roll: B.getLeanDeg() }, wheel: B.wheelAngle, crouch: B.braced ? -0.12 : 0 });
		}
		// Safe points for respawning after a crash.
		if (B.grounded && B.getSpeed() > 2 && B.shake < 0.3) this.groundedFor += dt; else this.groundedFor = 0;
		this.safeAccum += dt;
		if (this.groundedFor > 0.6 && this.safeAccum > 0.25) {
			this.safeAccum = 0;
			this.safePoints.push({ pos: B.getWorldLocation(), yaw: Math.atan2(B.vy, B.vx) / DEG, time: this.runTime, cp: this.nextCheckpoint });
			if (this.safePoints.length > 64) this.safePoints.shift();
		}
		this.result.topSpeed = Math.max(this.result.topSpeed, B.getSpeed());
		if (!B.grounded) this.result.airTime += dt;
		this.cleanStreak += dt;

		// Checkpoints.
		if (this.nextCheckpoint < W.checkpoints.length) {
			const G = W.checkpoints[this.nextCheckpoint];
			const goal = this.nextCheckpoint === W.checkpoints.length - 1;
			const P = B.getWorldLocation();
			const D = Math.hypot(P.x - G.pos.x, P.y - G.pos.y);
			if (goal) {
				if (D < G.radius && B.getSpeed() < 3.5 && B.grounded) {
					this.splits.push(this.runTime);
					this.deliver();
					return;
				}
				this.prompt = D < G.radius && B.getSpeed() >= 3.5 ? 'BRAKE TO HAND OVER' : '';
			} else if (D < G.radius && Math.abs(P.z - G.pos.z) < 8) {
				this.splits.push(this.runTime);
				this.lastSplitName = G.name;
				this.lastSplitAge = 0;
				this.lastSplitDelta = this.bestSplits.length > this.nextCheckpoint ? this.runTime - this.bestSplits[this.nextCheckpoint] : 0;
				this.nextCheckpoint++;
				this.audio.ui('Checkpoint');
			}
		}

		if (B.crashed) {
			this.result.crashes++;
			this.enterPhase('respawning');
			this.respawnAt = { pos: W.startPos.clone(), yaw: W.startYaw, time: 0, cp: 0 };
			for (let i = this.safePoints.length - 1; i >= 0; i--) {
				if (this.runTime - this.safePoints[i].time > 3.2) { this.respawnAt = this.safePoints[i]; break; }
			}
			return;
		}
		if (B.condition <= 0) { this.failRun('broken'); return; }
		if (this.runTime >= this.timeLimit) { this.failRun('late'); }
	}

	respawn() {
		const B = this.bike;
		B.resetTo(this.respawnAt.pos, this.respawnAt.yaw, 3);
		B.setFrozen(false);
		B.snapCamera();
		const t = this.respawnAt.time;
		this.safePoints = this.safePoints.filter((s) => s.time <= t);
		if (B.condition <= 0) this.failRun('broken');
	}

	handleShocks() {
		const B = this.bike;
		for (const E of B.pendingShocks) {
			this.audio.shock(E);
			this.rumble(E.type === 'crash' || E.type === 'splash' ? 1 : clamp(E.strength * 0.18 + E.damage * 0.05, 0, 0.9),
				E.type === 'crash' ? 0.5 : 0.12 + Math.min(E.damage, 10) * 0.02);
			if (E.damage > 0.4) {
				this.damageFlash = clamp(this.damageFlash + E.damage * 0.08, 0, 1);
				this.lastDamage = E.damage;
				this.cleanStreak = 0;
			}
			const pct = `-${Math.max(1, Math.round(E.damage))}%`;
			switch (E.type) {
				case 'wall': if (E.damage >= 1) this.addCallout('WALL', pct, ColBad, 0.9); break;
				case 'rattle': if (E.damage >= 2 && B.grounded) this.addCallout('RATTLED', pct, ColWarn, 0.8, 1.1); break;
				case 'crash': this.addCallout('WIPEOUT', pct, ColBad, 1.3, 2.0); break;
				case 'splash': this.addCallout('SPLASH', 'package soaked ' + pct, ColBad, 1.3, 2.0); break;
			}
		}
		B.pendingShocks.length = 0;
		for (const L of B.pendingLandings) {
			this.result.landings++;
			this.audio.landing(L);
			const dmg = L.damage >= 0.5 ? `-${Math.round(L.damage)}%` : 'no damage';
			if (L.perfect && L.damage < 3 && L.dropHeight > 0.6) {
				this.result.perfectLandings++;
				this.addCallout('FEATHER LANDING', `${L.dropHeight.toFixed(1)}m drop  ·  ${dmg}`, ColGood, 1.1);
			} else if (L.sketchy) this.addCallout('SKETCHY', dmg, ColBad, 1);
			else if (L.damage >= 6) this.addCallout('HARD LANDING', dmg, ColBad, 1);
			else if (L.damage >= 1.5) this.addCallout('THUD', dmg, ColWarn, 0.85);
			else if (L.dropHeight > 1.2) this.addCallout('CLEAN', `${L.dropHeight.toFixed(1)}m drop`, ColGood, 0.9);
		}
		B.pendingLandings.length = 0;
	}

	// ==================================================================================================
	// End of a run
	// ==================================================================================================
	computeResult() {
		const R = this.result;
		R.time = this.runTime;
		R.condition = this.bike.condition;
		const timeLeft = Math.max(0, this.timeLimit - this.runTime);
		R.timeBonus = timeLeft * 1.0;
		R.careMultiplier = Math.pow(R.condition / 100, 1.5);
		R.pristineBonus = R.condition >= 95 ? 15 : (R.condition >= 85 ? 6 : 0);
		R.tip = (20 + R.timeBonus) * R.careMultiplier + R.pristineBonus;
		const T = R.tip;
		R.grade = T >= 85 ? 'S' : T >= 65 ? 'A' : T >= 48 ? 'B' : T >= 32 ? 'C' : 'D';
	}

	deliver() {
		this.computeResult();
		this.bike.setFrozen(false);
		this.enterPhase('delivered');
		this.prompt = '';
		this.world.setGoalActive(false);
		this.ghostView.root.visible = false;
		const R = this.result;
		console.log(`MC_RESULT delivered time=${R.time.toFixed(2)} condition=${R.condition.toFixed(1)} tip=${R.tip.toFixed(2)} grade=${R.grade} landings=${R.landings} perfect=${R.perfectLandings} crashes=${R.crashes} top=${R.topSpeed.toFixed(1)}`);
		if (!this.hasBest || R.tip > this.best.tip) {
			this.newBest = true;
			this.best = { ...R };
			this.hasBest = true;
			this.bestSplits = [...this.splits];
			this.bestGhost = this.recording;
			if (!this.params.fresh) this.saveBest();
		}
	}

	failRun(why) {
		this.fail = why;
		this.computeResult();
		this.result.tip = 0;
		this.result.grade = '-';
		this.enterPhase('failed');
		this.prompt = '';
		this.ghostView.root.visible = false;
		console.log(`MC_RESULT failed why=${why} time=${this.runTime.toFixed(2)} condition=${this.bike.condition.toFixed(1)}`);
	}

	// ==================================================================================================
	// Ghost + saves
	// ==================================================================================================
	updateGhost(dt) {
		if (!this.ghostView.root.visible || this.bestGhost.length < 2) return;
		const T = this.phase === 'countdown' ? 0 : this.runTime;
		const F = T * 30;
		const I = clamp(Math.floor(F), 0, this.bestGhost.length - 2);
		const A = clamp(F - I, 0, 1);
		const g0 = this.bestGhost[I], g1 = this.bestGhost[I + 1];
		const P = g0.pos.clone().lerp(g1.pos, A);
		const R = { pitch: lerp(g0.rot.pitch, g1.rot.pitch, A), yaw: g0.rot.yaw + deltaAngleDeg(g0.rot.yaw, g1.rot.yaw) * A, roll: lerp(g0.rot.roll, g1.rot.roll, A) };
		this.ghost.setPoseFromRecording(P, R, T * 9, lerp(g0.wheel, g1.wheel, A), g0.crouch);
		if (F >= this.bestGhost.length - 1) this.ghostView.root.visible = false;
	}

	saveBest() {
		try {
			const n = this.bestGhost.length;
			const f = new Float32Array(n * 8);
			this.bestGhost.forEach((g, i) => f.set([g.pos.x, g.pos.y, g.pos.z, g.rot.pitch, g.rot.yaw, g.rot.roll, g.wheel, g.crouch], i * 8));
			let bin = '';
			const u8 = new Uint8Array(f.buffer);
			for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
			localStorage.setItem(SAVE_KEY, JSON.stringify({ best: this.best, splits: this.bestSplits, ghost: btoa(bin) }));
		} catch (e) { console.warn('save failed', e); }
	}

	loadBest() {
		try {
			const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
			if (!s) return;
			const bin = atob(s.ghost || '');
			const u8 = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
			const f = new Float32Array(u8.buffer, 0, Math.floor(u8.length / 4));
			this.bestGhost = [];
			for (let i = 0; i + 8 <= f.length && this.bestGhost.length < 30 * 60 * 5; i += 8) {
				this.bestGhost.push({ pos: new THREE.Vector3(f[i], f[i + 1], f[i + 2]), rot: { pitch: f[i + 3], yaw: f[i + 4], roll: f[i + 5] }, wheel: f[i + 6], crouch: f[i + 7] });
			}
			this.best = { ...emptyResult(), ...s.best };
			this.bestSplits = s.splits || [];
			this.hasBest = true;
		} catch (e) { this.hasBest = false; this.bestGhost = []; this.bestSplits = []; }
	}

	updateTitleCamera(dt) {
		this.titleOrbit += dt * 4;
		const B = this.bike;
		const c = B.getWorldLocation().add(new THREE.Vector3(0, 0, 1.2));
		const yaw = this.world.startYaw + 150 + Math.sin(this.titleOrbit * DEG) * 25;
		const loc = c.clone().addScaledVector(rotatorVector(-6, yaw), -5.2).add(new THREE.Vector3(0, 0, 0.4));
		B.cameraOverride = true;
		B.overrideLoc.copy(loc);
		B.overrideRot = vectorRotation(c.clone().add(new THREE.Vector3(0, 0, 0.1)).sub(loc));
		B.overrideFov = 55;
	}

	/** Everything the renderer needs this frame. */
	renderParams() {
		const B = this.bike;
		// Reflection plane: the ground under the bike, tilted to the slope the wheels sit on.
		if (B.grounded && !B.crashed) {
			const n0 = B.groundNormal[0], n1 = B.groundNormal[1];
			const n = new THREE.Vector3(n0.x + n1.x, n0.z + n1.z, n0.y + n1.y).normalize();
			if (n.y > 0.8) this.reflNormal.lerp(n, 0.1).normalize();
			const gz = B.pz - (Tune.Ext - Tune.Sag) - Tune.WheelR;
			this.reflPoint.set(B.px, gz + 0.02, B.py);
		}
		return {
			reflPlane: { point: this.reflPoint, normal: this.reflNormal },
			reflHide: [this.world.rain, this.bikeView.spray],
		};
	}
}
