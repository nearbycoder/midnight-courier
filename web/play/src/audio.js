// Port of UMcAudio: speed-driven loops, impacts, the package's glassy complaints, title/ride music crossfade.
// WebAudio buffers; loops play a one-period window cut out of a padded encode, so they are seamless.
import { clamp, finterp, randRange } from './math.js';

const BASE = 'assets/audio/';

export class Audio {
	constructor(settings) {
		this.settings = settings;
		this.muted = new URLSearchParams(location.search).has('mute');
		this.ctx = null;
		this.buffers = {};
		this.loops = {};
		this.clock = 0;
		this.lastTink = -1;
		this.musicLevel = 0;
		this.titleLevel = 0;
		this.lastCountdown = -1;
	}

	async load() {
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!AC || this.muted) return;
		this.ctx = new AC({ latencyHint: 'interactive' });
		this.master = this.ctx.createGain();
		this.master.connect(this.ctx.destination);
		this.manifest = await (await fetch(BASE + 'audio.json')).json();
		await Promise.all(Object.keys(this.manifest).map(async (name) => {
			try {
				const data = await (await fetch(BASE + name + '.mp3')).arrayBuffer();
				this.buffers[name] = await this.ctx.decodeAudioData(data);
			} catch (e) { console.warn('audio', name, e); }
		}));
		const L = (n, v) => { this.loops[n] = this.makeLoop(n, v); };
		L('A_RainLoop', 0.7); L('A_CityLoop', 0.35); L('A_WindLoop', 0); L('A_RollLoop', 0); L('A_FreewheelLoop', 0);
		L('A_ChainLoop', 0); L('A_SkidLoop', 0); L('A_MusicRide', 0); L('A_MusicTitle', 0.6);
	}

	/** Browsers only allow sound after a user gesture. */
	resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }

	makeLoop(name, vol) {
		const buf = this.buffers[name];
		if (!buf || !this.ctx) return null;
		const info = this.manifest[name];
		const src = this.ctx.createBufferSource();
		src.buffer = buf;
		src.loop = true;
		// Decoders that keep the MP3 priming add a few ms up front; any offset under the pad is harmless.
		const extra = Math.max(0, buf.duration - (info.dur + 2 * info.pad));
		src.loopStart = info.pad + Math.min(extra, 0.05) * 0.5;
		src.loopEnd = src.loopStart + info.dur;
		const g = this.ctx.createGain();
		g.gain.value = Math.max(0.0001, vol);
		src.connect(g).connect(this.master);
		src.start(0, src.loopStart);
		return {
			src, g,
			vol: (v) => g.gain.setTargetAtTime(Math.max(0, v), this.ctx.currentTime, 0.03),
			pitch: (p) => src.playbackRate.setTargetAtTime(clamp(p, 0.1, 4), this.ctx.currentTime, 0.03),
		};
	}

	play(name, volume = 1, pitch = 1) {
		if (!this.ctx || !this.buffers[name] || this.ctx.state !== 'running') return;
		const S = this.settings;
		const src = this.ctx.createBufferSource();
		src.buffer = this.buffers[name];
		src.playbackRate.value = pitch;
		const g = this.ctx.createGain();
		g.gain.value = volume * S.volume(S.sfx);
		src.connect(g).connect(this.master);
		src.start();
	}

	ui(name) { this.play('A_Ui' + name, 0.8); }

	onPhase(phase) {
		if (phase === 'delivered') this.play('A_Delivered', 0.9);
		else if (phase === 'failed') this.play('A_Failed', 0.9);
	}
	onRestart() { this.lastCountdown = -1; this.play('A_Restart', 0.7); }

	shock(E) {
		const pitch = randRange(0.9, 1.1);
		switch (E.type) {
			case 'rattle': this.play('A_Clack', clamp(E.strength * 0.35, 0.1, 0.9), pitch); break;
			case 'landing': this.play(E.strength > 3 ? 'A_ThudHeavy' : 'A_ThudLight', clamp(E.strength * 0.25, 0.2, 1), pitch); break;
			case 'wall': this.play('A_WallHit', clamp(E.strength * 0.2, 0.15, 1), pitch); break;
			case 'crash': this.play('A_Crash', 1); break;
			case 'splash': this.play('A_Splash', 1); break;
		}
		// The package complains: glassy tinkles for small knocks, a crack for real damage.
		if (E.damage >= 4) this.play('A_GlassCrack', clamp(0.4 + E.damage * 0.04, 0.4, 1), randRange(0.92, 1.08));
		else if (E.strength > 0.6 && this.clock - this.lastTink > 0.07) {
			this.lastTink = this.clock;
			this.play('A_GlassTink', clamp(E.strength * 0.3, 0.12, 0.8), randRange(0.85, 1.25));
		}
	}
	landing(L) { if (L.perfect && L.damage < 3 && L.dropHeight > 0.6) this.play('A_Perfect', 0.6); }

	update(dt, game) {
		this.clock += dt;
		if (!this.ctx) return;
		const S = this.settings;
		this.master.gain.value = 1;
		const B = game.bike;
		const ph = game.phase;
		const riding = ph === 'riding' || ph === 'respawning';
		const onBike = riding || ph === 'delivered' || ph === 'failed';
		const speed = B.getSpeed();
		const ground = B.grounded && !B.crashed;
		const s01 = clamp(speed / 16, 0, 1);
		const fx = S.volume(S.sfx), mus = S.volume(S.music), amb = S.volume(S.ambience);
		const paused = game.paused || game.settingsOpen;
		const k = paused ? 0.25 : 1;
		const lp = this.loops;
		const set = (n, v, p) => { const l = lp[n]; if (!l) return; l.vol(v * k); if (p !== undefined) l.pitch(p); };
		set('A_WindLoop', fx * (onBike ? s01 * s01 * 0.9 : 0), 0.7 + s01 * 0.7);
		set('A_RollLoop', fx * (onBike && ground ? clamp(speed / 10, 0, 1) * 0.7 : 0), 0.6 + s01 * 0.8);
		const pedal = riding && B.input.throttle > 0.05 && !B.braced && ground;
		set('A_ChainLoop', fx * (pedal ? 0.35 : 0), 0.8 + s01 * 0.6);
		set('A_FreewheelLoop', fx * (onBike && !pedal && speed > 1 ? 0.25 : 0), 0.4 + clamp(speed / 12, 0, 1.6));
		const skid = onBike && ground ? clamp(B.slip * 1.2 + (B.input.brake > 0.5 && speed > 5 ? 0.25 : 0), 0, 1) : 0;
		set('A_SkidLoop', fx * skid * 0.6, 0.85 + s01 * 0.3);
		// Music: the ride track comes in once you're moving, the title track on menus.
		const wantMusic = riding || ph === 'countdown' ? 0.55 : 0;
		const wantTitle = ph === 'title' ? 0.6 : (ph === 'delivered' || ph === 'failed' ? 0.35 : 0);
		this.musicLevel = finterp(this.musicLevel, wantMusic, dt, 1.5);
		this.titleLevel = finterp(this.titleLevel, wantTitle, dt, 1.0);
		if (lp.A_MusicRide) lp.A_MusicRide.vol(this.musicLevel * mus);
		if (lp.A_MusicTitle) lp.A_MusicTitle.vol(this.titleLevel * mus);
		set('A_RainLoop', amb * (0.55 + 0.2 * (1 - s01)));
		set('A_CityLoop', amb * 0.35);

		// Countdown beeps.
		if (ph === 'countdown') {
			const step = Math.floor(game.phaseTime / 0.5);
			if (step !== this.lastCountdown && step < 3) { this.lastCountdown = step; this.play('A_Beep', 0.6, 1); }
		} else if (ph === 'riding' && this.lastCountdown >= 0 && this.lastCountdown < 3) {
			this.lastCountdown = 99;
			this.play('A_Go', 0.7);
		}
		if (B.justHopped) this.play('A_Hop', 0.5, randRange(0.95, 1.05));
		const W = game.world;
		if (W.thunderPending) {
			W.thunderDelay -= dt;
			if (W.thunderDelay <= 0) { W.thunderPending = false; this.play(Math.random() < 0.5 ? 'A_Thunder1' : 'A_Thunder2', 0.8); }
		}
	}
}
