// Player options (port of FMcSettings for the browser). Persisted in localStorage, applied live.
import { QUALITY } from './render.js';

const KEY = 'midnight-courier.settings.v1';

export class Settings {
	constructor() {
		this.quality = 2;        // 0 Low .. 3 Ultra
		this.resScale = 0;       // 0 = auto, else 50..100 (% of the display's pixels)
		this.shadows = true;
		this.refl = true;
		this.effects = true;     // bloom + fog glow
		this.showFps = false;
		this.master = 8; this.music = 7; this.sfx = 8; this.ambience = 7;
		this.shake = 10;
		this.ghost = true;
		this.hints = true;
		this.rumble = true;
		this.load();
	}
	load() {
		try {
			const s = JSON.parse(localStorage.getItem(KEY) || '{}');
			for (const k of Object.keys(this)) if (k in s && typeof s[k] === typeof this[k]) this[k] = s[k];
		} catch { /* private mode etc. */ }
		this.quality = Math.max(0, Math.min(3, this.quality | 0));
	}
	save() {
		try { localStorage.setItem(KEY, JSON.stringify(this)); } catch { /* ignore */ }
	}
	volume(channel) { return (this.master / 10) * (channel / 10); }
	applyPreset() {
		const q = QUALITY[this.quality];
		this.shadows = q.shadows; this.refl = q.refl; this.effects = true;
	}
}

/** Rows of the settings screen; mirrors McBuildSettingsRows. onChange(kind) applies graphics changes. */
export function buildSettingsRows(S, { onGraphics, onBack, isFullscreen, toggleFullscreen, autoScale }) {
	const rows = [];
	const cycle = (v, d, min, max) => { v += d; if (v > max) v = min; if (v < min) v = max; return v; };
	const step = (v, d, min, max) => Math.max(min, Math.min(max, v + d));
	const onOff = (b) => (b ? 'ON' : 'OFF');
	const gfx = () => { onGraphics(); S.save(); };
	const names = ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'];
	rows.push({ label: 'Quality preset', section: 'GRAPHICS', value: () => names[S.quality], change: (d) => { S.quality = cycle(S.quality, d === 0 ? 1 : d, 0, 3); S.applyPreset(); gfx(); } });
	rows.push({
		label: 'Resolution scale', value: () => (S.resScale > 0 ? `${S.resScale}%` : `AUTO (${autoScale()}%)`),
		change: (d) => {
			let v = S.resScale === 0 ? 45 : S.resScale;
			v += d === 0 ? 5 : d * 5;
			if (v > 100) v = 0; else if (v < 50) v = (d < 0 && S.resScale === 50) ? 0 : 50;
			if (S.resScale === 0 && d < 0) v = 100;
			S.resScale = v; gfx();
		},
	});
	rows.push({ label: 'Shadows', value: () => onOff(S.shadows), change: () => { S.shadows = !S.shadows; gfx(); } });
	rows.push({ label: 'Wet reflections', value: () => onOff(S.refl), change: () => { S.refl = !S.refl; gfx(); } });
	rows.push({ label: 'Bloom & fog glow', value: () => onOff(S.effects), change: () => { S.effects = !S.effects; gfx(); } });
	rows.push({ label: 'Display', value: () => (isFullscreen() ? 'FULL SCREEN' : 'WINDOW'), change: () => toggleFullscreen() });
	rows.push({ label: 'Show FPS', value: () => onOff(S.showFps), change: () => { S.showFps = !S.showFps; S.save(); } });
	const vol = (v) => `${v * 10}%`;
	rows.push({ label: 'Master volume', section: 'SOUND', value: () => vol(S.master), change: (d) => { S.master = step(S.master, d === 0 ? 1 : d, 0, 10); S.save(); } });
	rows.push({ label: 'Music', value: () => vol(S.music), change: (d) => { S.music = step(S.music, d === 0 ? 1 : d, 0, 10); S.save(); } });
	rows.push({ label: 'Effects', value: () => vol(S.sfx), change: (d) => { S.sfx = step(S.sfx, d === 0 ? 1 : d, 0, 10); S.save(); } });
	rows.push({ label: 'Rain & city', value: () => vol(S.ambience), change: (d) => { S.ambience = step(S.ambience, d === 0 ? 1 : d, 0, 10); S.save(); } });
	rows.push({ label: 'Camera shake', section: 'GAMEPLAY', value: () => vol(S.shake), change: (d) => { S.shake = step(S.shake, d === 0 ? 1 : d, 0, 10); S.save(); } });
	rows.push({ label: 'Ghost of your best run', value: () => onOff(S.ghost), change: () => { S.ghost = !S.ghost; S.save(); } });
	rows.push({ label: 'Control hints', value: () => onOff(S.hints), change: () => { S.hints = !S.hints; S.save(); } });
	rows.push({ label: 'Controller rumble', value: () => onOff(S.rumble), change: () => { S.rumble = !S.rumble; S.save(); } });
	rows.push({ label: 'BACK', action: true, value: () => '', change: (d) => { if (d === 0) onBack(); } });
	return rows;
}
