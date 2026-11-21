// HUD and screens: a port of AMcHud (McHud.cpp). Unreal draws them immediate-mode on a canvas; here the
// same calls drive pooled DOM elements (text, panels) plus a 2D canvas for the vector bits (compass,
// minimap, cracks). Layout units are Unreal's: S = 1 at 1080 lines (also capped by width so nothing overlaps
// on narrow windows). Font sizes are Slate points (96 dpi).
import { clamp, finterp, linearToSrgb, easeOut } from './math.js';

const FACES = {
	Display: { family: 'Anton', weight: 400, style: 'normal' },
	Bold: { family: 'Barlow Condensed', weight: 700, style: 'normal' },
	Semi: { family: 'Barlow Condensed', weight: 600, style: 'normal' },
	Medium: { family: 'Barlow Condensed', weight: 500, style: 'normal' },
	Italic: { family: 'Barlow Condensed', weight: 700, style: 'italic' },
	HeavyItalic: { family: 'Barlow Condensed', weight: 800, style: 'italic' },
};
const PT = 4 / 3;

export const C = {
	Ink: [0.93, 0.95, 1, 1], Dim: [0.6, 0.66, 0.76, 1], Amber: [1, 0.7, 0.22, 1], Teal: [0.3, 0.95, 0.85, 1],
	Red: [1, 0.28, 0.22, 1], Panel: [0.015, 0.02, 0.035, 0.72], Magenta: [1, 0.25, 0.6, 1],
	Good: [0.35, 1, 0.75, 1], Gold: [1, 0.78, 0.25, 1], Bad: [1, 0.32, 0.25, 1], Warn: [1, 0.62, 0.2, 1], Info: [0.6, 0.85, 1, 1],
};
const withA = (c, a) => [c[0], c[1], c[2], c[3] * a];
function css(c) {
	return `rgba(${Math.round(linearToSrgb(clamp(c[0], 0, 1)) * 255)},${Math.round(linearToSrgb(clamp(c[1], 0, 1)) * 255)},${Math.round(linearToSrgb(clamp(c[2], 0, 1)) * 255)},${clamp(c[3], 0, 1).toFixed(3)})`;
}
function fontCss(face, px) { const f = FACES[face]; return `${f.style} ${f.weight} ${px.toFixed(2)}px "${f.family}"`; }

/** Deterministic stand-in for FRandomStream. */
function stream(seed) {
	let s = seed >>> 0;
	return { range(a, b) { s = (s * 196314165 + 907633515) >>> 0; return a + (s / 4294967296) * (b - a); } };
}

export function formatTime(t, tenths = true) {
	t = Math.max(0, t);
	const m = Math.floor(t / 60), sec = t - m * 60;
	if (tenths) {
		const whole = Math.floor(sec), hund = Math.floor((sec - whole) * 100);
		return `${m}:${String(whole).padStart(2, '0')}.${String(hund).padStart(2, '0')}`;
	}
	return `${m}:${String(Math.floor(sec)).padStart(2, '0')}`;
}

export class Hud {
	constructor(root, lines) {
		this.root = root;
		this.lines = lines;
		this.lctx = lines.getContext('2d');
		this.mctx = document.createElement('canvas').getContext('2d');
		this.texts = []; this.rects = [];
		this.ti = 0; this.ri = 0;
		this.S = 1; this.W = 0; this.H = 0;
		this.clock = 0;
		this.shownCondition = 100;
		this.shownG = 1;
		this.onAction = null;
		this.onHover = null;
		root.addEventListener('click', (e) => { const a = e.target.closest('[data-action]'); if (a && this.onAction) this.onAction(a.dataset.action, e); });
		root.addEventListener('mousemove', (e) => {
			const a = e.target.closest('[data-action]');
			if (a && this.onHover && e.movementX * e.movementX + e.movementY * e.movementY > 0) this.onHover(a.dataset.action);
		});
	}

	// ---- immediate-mode primitives ----------------------------------------------------------------------
	begin(dt) {
		const W = window.innerWidth, H = window.innerHeight;
		if (W !== this.W || H !== this.H) {
			const dpr = window.devicePixelRatio || 1;
			this.lines.width = Math.round(W * dpr); this.lines.height = Math.round(H * dpr);
			this.dpr = dpr;
		}
		this.W = W; this.H = H;
		this.S = Math.min(H / 1080, W / 1200);
		this.clock += dt;
		this.ti = 0; this.ri = 0; this.z = 0;
		this.lctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		this.lctx.clearRect(0, 0, W, H);
	}
	end() {
		for (let i = this.ti; i < this.texts.length; i++) if (this.texts[i]._vis) { this.texts[i].style.display = 'none'; this.texts[i]._vis = false; }
		for (let i = this.ri; i < this.rects.length; i++) if (this.rects[i]._vis) { this.rects[i].style.display = 'none'; this.rects[i]._vis = false; }
	}
	_el(pool, idx, cls) {
		let e = pool[idx];
		if (!e) { e = document.createElement('div'); e.className = cls; e._p = {}; this.root.appendChild(e); pool[idx] = e; }
		if (!e._vis) { e.style.display = ''; e._vis = true; }
		return e;
	}
	_set(e, k, v) { if (e._p[k] !== v) { e._p[k] = v; e.style[k] = v; } }
	_attr(e, action) {
		const a = action || '';
		if (e._p.action !== a) {
			e._p.action = a;
			if (a) { e.dataset.action = a; e.classList.add('menu'); } else { delete e.dataset.action; e.classList.remove('menu'); }
		}
	}

	measure(str, face, size, spacing = 0) {
		const S = this.S;
		this.mctx.font = fontCss(face, size * S * PT);
		const w = this.mctx.measureText(str).width + str.length * (spacing / 1000) * size * S * PT;
		return { x: w, y: size * S * PT * 1.2 };
	}

	/** Mirrors AMcHud::Text: x/y in pixels, size in points (scaled by S), returns width. */
	text(str, x, y, face, size, color, align = 'left', shadow = 2, spacing = 0, action = null) {
		if (!str || color[3] <= 0.001) return 0;
		const S = this.S;
		const e = this._el(this.texts, this.ti++, 't');
		this._set(e, 'zIndex', String(++this.z));
		const px = size * S * PT;
		if (e._p.txt !== str) { e._p.txt = str; e.textContent = str; }
		this._set(e, 'font', fontCss(face, px));
		this._set(e, 'color', css(color));
		this._set(e, 'letterSpacing', spacing ? `${(spacing / 1000).toFixed(4)}em` : 'normal');
		this._set(e, 'textShadow', shadow > 0 ? `${(shadow * S).toFixed(1)}px ${(shadow * S).toFixed(1)}px 0 rgba(0,0,0,${(0.6 * color[3]).toFixed(3)})` : 'none');
		const tx = align === 'center' ? '-50%' : align === 'right' ? '-100%' : '0';
		this._set(e, 'transform', `translate(${Math.round(x)}px, ${Math.round(y)}px) translateX(${tx})`);
		this._attr(e, action);
		return action ? 0 : this.measure(str, face, size, spacing).x;
	}

	/** A full-screen overlay also has to fade the vector layer (which sits above the DOM). */
	cover(color) {
		const g = this.lctx;
		g.globalCompositeOperation = 'destination-in';
		g.fillStyle = `rgba(0,0,0,${(1 - clamp(color[3], 0, 1)).toFixed(3)})`;
		g.fillRect(0, 0, this.W, this.H);
		g.globalCompositeOperation = 'source-over';
	}

	rect(x, y, w, h, color, action = null, background = null) {
		if (!background && color[3] <= 0.001) return;
		const e = this._el(this.rects, this.ri++, 'r');
		this._set(e, 'zIndex', String(++this.z));
		this._set(e, 'transform', `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`);
		this._set(e, 'width', `${Math.max(0, w).toFixed(1)}px`);
		this._set(e, 'height', `${Math.max(0, h).toFixed(1)}px`);
		this._set(e, 'background', background || css(color));
		this._attr(e, action);
	}

	line(x0, y0, x1, y1, color, thick = 1) {
		const g = this.lctx;
		g.strokeStyle = css(color);
		g.lineWidth = thick;
		g.lineCap = 'round';
		g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
	}

	// =================================================================================================
	// Screens
	// =================================================================================================
	draw(G, dt) {
		this.begin(dt);
		const S = this.S, W = this.W, H = this.H;
		switch (G.phase) {
			case 'title': this.drawTitle(G); break;
			case 'countdown': case 'riding': case 'respawning': this.drawRiding(G, dt); break;
			case 'delivered': case 'failed': this.drawResults(G); break;
			default: break;
		}
		if (G.paused && !G.settingsOpen) this.drawPause(G);
		if (G.settingsOpen) this.drawSettings(G);
		if (G.settings.showFps) {
			this.text(`${Math.round(G.measuredFps)} FPS  ·  ${(1000 / Math.max(G.measuredFps, 1)).toFixed(1)} ms`, W - 20 * S, H - 26 * S, 'Semi', 15, C.Dim, 'right', 1, 1);
		}
		if (G.fade > 0.001) { this.rect(0, 0, W, H, [0, 0, 0, G.fade]); this.cover([0, 0, 0, G.fade]); }
		this.end();
	}

	drawRiding(G, dt) {
		const S = this.S, W = this.W, H = this.H;
		const B = G.bike;
		const remaining = G.timeLimit - G.runTime;

		// Damage vignette.
		if (G.damageFlash > 0.01) {
			const A = G.damageFlash * 0.35;
			this.rect(0, 0, W, 40 * S, withA(C.Red, A));
			this.rect(0, H - 40 * S, W, 40 * S, withA(C.Red, A));
			this.rect(0, 0, 40 * S, H, withA(C.Red, A * 0.7));
			this.rect(W - 40 * S, 0, 40 * S, H, withA(C.Red, A * 0.7));
		}

		// ---- clock --------------------------------------------------------------------------------------
		{
			const low = remaining < 15;
			const pulse = low ? 0.75 + 0.25 * Math.sin(this.clock * 10) : 1;
			const col = low ? withA(C.Red, pulse) : C.Ink;
			this.text('TIME LEFT', W * 0.5, 26 * S, 'Semi', 17, C.Dim, 'center', 1, 4);
			this.text(formatTime(remaining), W * 0.5, 42 * S, 'Display', 58, col, 'center', 3, 1);
			// Split against the best run.
			if (G.lastSplitAge < 3.5 && G.bestSplits.length > 0) {
				const A = clamp((3.5 - G.lastSplitAge) / 0.5, 0, 1);
				const D = G.lastSplitDelta;
				this.text(`${D <= 0 ? '-' : '+'}${Math.abs(D).toFixed(2)}`, W * 0.5, 118 * S, 'HeavyItalic', 34, withA(D <= 0 ? C.Teal : C.Red, A), 'center');
				this.text(G.lastSplitName.toUpperCase(), W * 0.5, 156 * S, 'Semi', 16, withA(C.Dim, A), 'center', 1, 3);
			} else if (G.lastSplitAge < 2.5) {
				const A = clamp((2.5 - G.lastSplitAge) / 0.5, 0, 1);
				this.text(G.lastSplitName.toUpperCase(), W * 0.5, 122 * S, 'Bold', 22, withA(C.Teal, A), 'center', 1, 3);
			}
		}

		// ---- drop-off compass -------------------------------------------------------------------------------
		if (G.phase !== 'countdown') {
			const cx = W * 0.5, cy = 190 * S;
			const ang = G.goalBearing * Math.PI / 180;
			const dx = Math.sin(ang), dy = -Math.cos(ang);
			const px = -dy, py = dx;
			const tx = cx + dx * 16 * S, ty = cy + dy * 16 * S;
			this.line(tx, ty, cx - dx * 10 * S + px * 11 * S, cy - dy * 10 * S + py * 11 * S, C.Amber, 3 * S);
			this.line(tx, ty, cx - dx * 10 * S - px * 11 * S, cy - dy * 10 * S - py * 11 * S, C.Amber, 3 * S);
			this.text(`${Math.round(G.distanceToGoal)} m`, cx, cy + 18 * S, 'Semi', 18, C.Amber, 'center', 1, 2);
		}

		// ---- best run, top right --------------------------------------------------------------------------
		if (G.hasBest) {
			this.text('BEST TIP', W - 40 * S, 30 * S, 'Semi', 16, C.Dim, 'right', 1, 3);
			this.text(`$${G.best.tip.toFixed(2)}  ${G.best.grade}`, W - 40 * S, 48 * S, 'Bold', 30, C.Ink, 'right');
			this.text(`${formatTime(G.best.time)}  ·  ${Math.round(G.best.condition)}%`, W - 40 * S, 84 * S, 'Medium', 18, C.Dim, 'right');
			if (G.isGhostVisible()) this.text('GHOST  [G]', W - 40 * S, 108 * S, 'Semi', 15, withA(C.Teal, 0.8), 'right', 1, 2);
		}

		// ---- speed, bottom left -----------------------------------------------------------------------------
		{
			const kmh = Math.round(B.getSpeed() * 3.6);
			// Unreal: Y = H - 150 with chips at +98, which lets a chip clip the digits; nudge both apart.
			const X = 50 * S, Y = H - 160 * S;
			this.text(String(kmh), X, Y, 'Display', 72, C.Ink, 'left', 3);
			const wd = this.measure(String(kmh), 'Display', 72).x;
			this.text('KM/H', X + wd + 10 * S, Y + 52 * S, 'Semi', 18, C.Dim, 'left', 1, 3);
			let cx = X;
			const chip = (label, col) => {
				const tw = this.measure(label, 'Bold', 15, 2).x;
				this.rect(cx, Y + 116 * S, tw + 16 * S, 24 * S, withA(col, 0.18));
				this.text(label, cx + 8 * S, Y + 118 * S, 'Bold', 15, col, 'left', 0, 2);
				cx += tw + 24 * S;
			};
			if (B.braced) chip('BRACED', C.Teal);
			if (B.driftActive) chip('SLIDE', C.Amber);
			if (!B.grounded && B.airTime > 0.25) chip(`AIR ${B.airTime.toFixed(1)}s`, C.Ink);
		}

		this.drawPackage(G, W - 50 * S, H - 50 * S, dt);
		if (G.world.mapLines.length > 0) this.drawMinimap(G, 50 * S + 110 * S, H - 330 * S, 220 * S);

		// ---- callouts ----------------------------------------------------------------------------------------
		{
			let y = H * 0.30;
			for (const c of G.callouts) {
				const inA = clamp(c.age / 0.12, 0, 1);
				const outA = clamp((c.life - c.age) / 0.35, 0, 1);
				const A = inA * outA;
				const pop = 1 + (1 - inA) * 0.25;
				this.text(c.text, W * 0.5, y, 'HeavyItalic', 40 * c.size * pop, withA(c.color, A), 'center', 3, 2);
				y += 44 * S * c.size;
				if (c.sub) {
					this.text(c.sub, W * 0.5, y, 'Semi', 20, withA(C.Ink, A * 0.85), 'center', 1.5, 2);
					y += 28 * S;
				}
				y += 8 * S;
			}
		}

		if (G.prompt) {
			const A = 0.7 + 0.3 * Math.sin(this.clock * 8);
			this.text(G.prompt, W * 0.5, H * 0.62, 'Bold', 30, withA(C.Amber, A), 'center', 2, 4);
		}

		// ---- countdown --------------------------------------------------------------------------------------
		if (G.phase === 'countdown') {
			const step = Math.floor(G.phaseTime / 0.5);
			const local = (G.phaseTime / 0.5) % 1;
			const L = step === 0 ? '3' : step === 1 ? '2' : '1';
			const sc = 1.3 - local * 0.3;
			this.text(L, W * 0.5, H * 0.36, 'Display', 150 * sc, withA(C.Ink, 1 - local * 0.6), 'center', 4);
			if (G.runCount <= 1) this.text("Deliver the package to the Hotel Marlowe. Don't break it.", W * 0.5, H * 0.62, 'Medium', 26, C.Ink, 'center', 2);
		} else if (G.phase === 'riding' && G.phaseTime < 0.7 && G.runTime < 1) {
			const A = 1 - G.phaseTime / 0.7;
			this.text('GO', W * 0.5, H * 0.36, 'Display', 150 * (1 + (1 - A) * 0.4), withA(C.Amber, A), 'center', 4);
		}

		// First-run control hints.
		if (G.settings.hints && G.runCount <= 2 && G.runTime < 14 && G.phase === 'riding') {
			const A = clamp((14 - G.runTime) / 1.5, 0, 1) * 0.9;
			const y = H - 96 * S;
			const pad = G.input.lastDevice === 'gamepad';
			this.text(pad ? 'RT pedal  ·  LT brake  ·  stick steer  ·  X / RB slide' : 'W pedal  ·  S brake  ·  A/D steer  ·  SHIFT slide', W * 0.5, y, 'Medium', 20, withA(C.Dim, A), 'center', 1, 1);
			this.text(pad ? 'hold A to brace, release to hop  ·  Y restart' : 'hold SPACE to brace, release to hop  ·  R restart', W * 0.5, y + 28 * S, 'Medium', 20, withA(C.Dim, A), 'center', 1, 1);
		}
	}

	drawPackage(G, right, bottom, dt) {
		const S = this.S;
		const B = G.bike;
		const cond = B.condition;
		this.shownCondition = finterp(this.shownCondition, cond, dt, 6);
		this.shownG = Math.max(B.packageG, this.shownG - dt * 3);
		const wd = 300 * S;
		const X = right - wd, Y = bottom - 150 * S;
		this.rect(X - 16 * S, Y - 14 * S, wd + 32 * S, 164 * S, C.Panel);
		const col = cond > 75 ? C.Teal : cond > 40 ? C.Amber : C.Red;
		this.text('PACKAGE', X, Y, 'Semi', 16, C.Dim, 'left', 0, 3);
		this.text('FRAGILE · ANTIQUE GLASS', X + wd, Y, 'Semi', 14, withA(C.Amber, 0.8), 'right', 0, 2);
		this.text(`${Math.ceil(this.shownCondition - 1e-4)}%`, X, Y + 22 * S, 'Display', 44, col, 'left', 2);
		// The box icon picks up cracks as it suffers.
		{
			const bx = X + wd - 56 * S, by = Y + 28 * S, bs = 50 * S;
			const jit = clamp(this.shownG - 1.5, 0, 3) * 2 * S;
			const jx = Math.sin(this.clock * 71) * jit, jy = Math.sin(this.clock * 59) * jit;
			this.rect(bx + jx, by + jy, bs, bs, [0.55, 0.38, 0.2, 0.95]);
			this.rect(bx + jx, by + jy + bs * 0.42, bs, bs * 0.16, [0.75, 0.62, 0.38, 0.95]);
			this.text('!', bx + jx + bs * 0.5, by + jy + 2 * S, 'Display', 30, [0.7, 0.08, 0.05, 1], 'center', 0);
			const cracks = Math.floor((1 - cond / 100) * 7);
			const R = stream(1234);
			for (let i = 0; i < cracks; i++) {
				let px = bx + jx + R.range(0.15, 0.85) * bs, py = by + jy + R.range(0.1, 0.9) * bs;
				for (let k = 0; k < 3; k++) {
					const nx = px + R.range(-0.25, 0.25) * bs, ny = py + R.range(-0.25, 0.25) * bs;
					this.line(px, py, clamp(nx, bx + jx, bx + jx + bs), clamp(ny, by + jy, by + jy + bs), [0.05, 0.02, 0.01, 0.9], 2 * S);
					px = nx; py = ny;
				}
			}
		}
		// Condition bar.
		const barY = Y + 98 * S;
		this.rect(X, barY, wd, 8 * S, [1, 1, 1, 0.08]);
		this.rect(X, barY, wd * this.shownCondition / 100, 8 * S, col);
		if (cond < this.shownCondition - 0.5) this.rect(X + wd * cond / 100, barY, wd * (this.shownCondition - cond) / 100, 8 * S, withA(C.Red, 0.9));
		// Live shock meter: how hard the box is being shaken right now.
		const gbar = clamp((this.shownG - 1) / 4, 0, 1);
		const gy = barY + 22 * S;
		this.text('SHOCK', X, gy - 3 * S, 'Semi', 13, C.Dim, 'left', 0, 2);
		const mx = X + 52 * S, mw = wd - 52 * S, segs = 16;
		for (let i = 0; i < segs; i++) {
			const f = i / segs;
			const sc = f < 0.4 ? C.Teal : f < 0.7 ? C.Amber : C.Red;
			this.rect(mx + i * (mw / segs), gy, mw / segs - 3 * S, 10 * S, f < gbar ? sc : [1, 1, 1, 0.07]);
		}
	}

	drawMinimap(G, cx, cy, size) {
		const S = this.S;
		const Wd = G.world, B = G.bike;
		const P = B.getWorldLocation();
		const camYaw = G.cameraYaw;
		const range = 260;             // metres shown across the map
		const scale = size / range;
		const ang = (-camYaw - 90) * Math.PI / 180;
		const ca = Math.cos(ang), sa = Math.sin(ang);
		const toMap = (qx, qy) => { const dx = qx - P.x, dy = qy - P.y; return [cx + (dx * ca - dy * sa) * scale, cy + (dx * sa + dy * ca) * scale]; };
		const R = size * 0.5;
		this.rect(cx - R, cy - R, size, size, [0.01, 0.015, 0.03, 0.55]);
		const inside = (q) => Math.abs(q[0] - cx) < R && Math.abs(q[1] - cy) < R;
		const clip = (a, b, inset) => {
			const x0 = cx - R + inset, x1 = cx + R - inset, y0 = cy - R + inset, y1 = cy + R - inset;
			const dx = b[0] - a[0], dy = b[1] - a[1];
			let t0 = 0, t1 = 1;
			const p = [-dx, dx, -dy, dy], q = [a[0] - x0, x1 - a[0], a[1] - y0, y1 - a[1]];
			for (let k = 0; k < 4; k++) {
				if (Math.abs(p[k]) < 1e-6) { if (q[k] < 0) return null; continue; }
				const t = q[k] / p[k];
				if (p[k] < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
				if (t0 > t1) return null;
			}
			return [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1]];
		};
		for (const L of Wd.mapLines) {
			const kind = L.kind;
			const col = kind === 0 ? [0.6, 0.65, 0.75, 0.55] : kind === 3 ? [0.2, 0.45, 0.7, 0.6] : [1, 0.7, 0.25, 0.7];
			const T = (kind === 0 ? 5 : kind === 3 ? 2 : 3) * S;
			for (let k = 0; k + 1 < L.pts.length; k++) {
				const s = clip(toMap(L.pts[k][0], L.pts[k][1]), toMap(L.pts[k + 1][0], L.pts[k + 1][1]), T * 0.5 + 1);
				if (s) this.line(s[0][0], s[0][1], s[1][0], s[1][1], col, T);
			}
		}
		// Drop-off.
		{
			const g = toMap(Wd.goalPos.x, Wd.goalPos.y);
			const pulse = 5 + 2 * Math.sin(this.clock * 5);
			g[0] = clamp(g[0], cx - R + 9 * S, cx + R - 9 * S);
			g[1] = clamp(g[1], cy - R + 9 * S, cy + R - 9 * S);
			this.rect(g[0] - pulse * S, g[1] - pulse * S, pulse * 2 * S, pulse * 2 * S, C.Amber);
		}
		// Ghost.
		if (G.isGhostVisible()) {
			const gm = toMap(G.ghost.px, G.ghost.py);
			if (inside(gm)) this.rect(gm[0] - 4 * S, gm[1] - 4 * S, 8 * S, 8 * S, withA(C.Teal, 0.8));
		}
		// You (always pointing up).
		this.line(cx, cy - 10 * S, cx - 7 * S, cy + 7 * S, C.Ink, 2.5 * S);
		this.line(cx, cy - 10 * S, cx + 7 * S, cy + 7 * S, C.Ink, 2.5 * S);
		this.line(cx - 7 * S, cy + 7 * S, cx + 7 * S, cy + 7 * S, C.Ink, 2.5 * S);
	}

	drawTitle(G) {
		const S = this.S, W = this.W, H = this.H;
		const A = clamp(G.phaseTime / 1.2, 0, 1);
		// Left-side gradient panel: alpha 0.85 (1 - f)^2 across 60% of the width.
		const stops = [];
		for (let i = 0; i <= 8; i++) { const f = i / 8; stops.push(`rgba(1,2,10,${(0.85 * (1 - f) * (1 - f) * A * 0.93).toFixed(3)}) ${(f * 100).toFixed(0)}%`); }
		this.rect(0, 0, W * 0.6, H, [0, 0, 0, 1], null, `linear-gradient(90deg, ${stops.join(', ')})`);
		const X = 110 * S;
		let Y = H * 0.14;
		this.text('MIDNIGHT', X, Y, 'Display', 118, withA(C.Ink, A), 'left', 4, 6);
		Y += 150 * S;
		this.text('COURIER', X, Y, 'Display', 118, withA(C.Amber, A), 'left', 4, 6);
		Y += 190 * S;
		this.text('One package. Ridiculously fragile.', X, Y, 'Medium', 30, withA(C.Ink, A * 0.95), 'left', 2);
		Y += 40 * S;
		this.text('Two minutes to get it down the hill.', X, Y, 'Medium', 30, withA(C.Ink, A * 0.95), 'left', 2);
		Y += 80 * S;
		const items = ['RIDE', 'SETTINGS', 'FULL SCREEN'];
		if (document.fullscreenElement) items[2] = 'WINDOW';
		for (let i = 0; i < 3; i++) {
			const sel = G.titleIndex === i && !G.settingsOpen;
			const pulse = sel ? 0.75 + 0.25 * Math.sin(this.clock * 4) : 1;
			if (sel) this.rect(X - 22 * S, Y + 8 * S, 8 * S, 28 * S, withA(C.Amber, A * pulse));
			this.text(items[i], X, Y, 'Bold', 36, withA(sel ? C.Amber : C.Dim, A * pulse), 'left', 2, 5, `title:${i}`);
			Y += 50 * S;
		}
		Y += 30 * S;
		const pad = G.input.lastDevice === 'gamepad';
		const rows = [
			['W / RT', 'pedal'], ['S / LT', 'brake'], ['A D / stick', 'steer  ·  in the air, W S tilt the bike'],
			['SPACE / A', 'hold to brace for impact, release to hop'], ['SHIFT / X', 'power slide'], ['R / Y', 'instant restart'],
		];
		void pad;
		for (const r of rows) {
			this.text(r[0], X, Y, 'Bold', 20, withA(C.Amber, A * 0.9), 'left', 1, 2);
			this.text(r[1], X + 150 * S, Y, 'Medium', 20, withA(C.Dim, A), 'left', 1);
			Y += 28 * S;
		}
		if (G.hasBest) {
			Y += 30 * S;
			this.text(`BEST TIP  $${G.best.tip.toFixed(2)}  ·  ${G.best.grade}  ·  ${formatTime(G.best.time)}  ·  package ${Math.round(G.best.condition)}%`, X, Y, 'Semi', 22, withA(C.Ink, A), 'left', 1, 2);
		}
		if (!G.audioReady) {
			const a2 = A * (0.55 + 0.25 * Math.sin(this.clock * 3));
			this.text('press any key or click for sound', W - 40 * S, H - 50 * S, 'Medium', 18, withA(C.Dim, a2), 'right', 1, 1);
		}
	}

	drawResults(G) {
		const S = this.S, W = this.W, H = this.H;
		const T = G.phaseTime;
		const A = clamp((T - 0.4) / 0.5, 0, 1);
		this.rect(0, 0, W, H, [0, 0, 0.02, 0.45 * A]);
		const R = G.result;
		const cx = W * 0.5;
		let Y = H * 0.16;
		if (G.phase === 'failed') {
			const broken = G.fail === 'broken';
			this.text(broken ? 'PACKAGE DESTROYED' : 'TOO LATE', cx, Y, 'Display', 96, withA(C.Red, A), 'center', 4, 4);
			Y += 150 * S;   // Unreal uses 120, which lets the subtitle touch the heading
			this.text(broken ? 'The client hears it before they see it. No tip tonight.' : "The hotel's night manager has already gone home. No tip tonight.", cx, Y, 'Medium', 28, withA(C.Ink, A), 'center', 2);
			Y += 90 * S;
			this.text('PRESS R TO TRY AGAIN', cx, Y, 'Bold', 30, withA(C.Teal, A * (0.6 + 0.4 * Math.sin(this.clock * 3))), 'center', 2, 5, 'again');
			return;
		}
		this.text('DELIVERED', cx, Y, 'Display', 96, withA(C.Amber, A), 'center', 4, 6);
		Y += 152 * S;   // Unreal: 140 (the verdict touches the heading)
		const cond = R.condition;
		const verdict = cond >= 98 ? '"Not a scratch. Are you even human?"'
			: cond >= 90 ? '"Perfect. Just perfect."'
				: cond >= 75 ? '"Is that... a chip? Fine. It\'s fine."'
					: cond >= 50 ? '"Why does it rattle when I shake it?"'
						: cond >= 25 ? '"This was my grandmother\'s."'
							: '"Is this... glitter? It used to be a swan."';
		this.text(verdict, cx, Y, 'Italic', 30, withA(C.Ink, A), 'center', 2);
		Y += 70 * S;
		const rows = [];
		rows.push(['TIME', formatTime(R.time), C.Ink]);
		rows.push(['PACKAGE', `${Math.round(R.condition)}%`, cond > 75 ? C.Teal : cond > 40 ? C.Amber : C.Red]);
		rows.push(['DELIVERY FEE + EARLY BONUS', `$${(20 + R.timeBonus).toFixed(2)}`, C.Ink]);
		rows.push(['CARE MULTIPLIER', `x${R.careMultiplier.toFixed(2)}`, C.Ink]);
		if (R.pristineBonus > 0) rows.push([R.pristineBonus >= 15 ? 'PRISTINE BONUS' : 'CAREFUL BONUS', `+$${R.pristineBonus.toFixed(2)}`, C.Teal]);
		rows.push(['LANDINGS  ·  FEATHERED', `${R.landings}  ·  ${R.perfectLandings}`, C.Dim]);
		if (R.crashes > 0) rows.push(['WIPEOUTS', String(R.crashes), C.Red]);
		const rowW = 560 * S;
		rows.forEach((r, i) => {
			const RA = clamp((T - 0.8 - i * 0.18) / 0.25, 0, 1);
			this.text(r[0], cx - rowW * 0.5, Y, 'Semi', 22, withA(C.Dim, RA), 'left', 1, 2);
			this.text(r[1], cx + rowW * 0.5, Y - 4 * S, 'Bold', 30, withA(r[2], RA), 'right', 1);
			Y += 40 * S;
		});
		Y += 16 * S;
		const TA = clamp((T - 0.9 - rows.length * 0.18) / 0.3, 0, 1);
		this.rect(cx - rowW * 0.5, Y, rowW, 2 * S, withA(C.Ink, TA * 0.4));
		Y += 16 * S;
		const count = clamp((T - 1.0 - rows.length * 0.18) / 0.8, 0, 1);
		this.text('TIP', cx - rowW * 0.5, Y + 18 * S, 'Bold', 30, withA(C.Ink, TA), 'left', 1, 4);
		this.text(`$${(R.tip * easeOut(0, 1, count, 3)).toFixed(2)}`, cx + rowW * 0.5, Y, 'Display', 64, withA(C.Amber, TA), 'right', 3);
		if (count >= 1) {
			const GA = clamp((T - 2.0 - rows.length * 0.18) / 0.15, 0, 1);
			const sc = 1 + (1 - GA) * 1.5;
			this.text(R.grade, cx + rowW * 0.5 + 110 * S, Y - 40 * S - (sc - 1) * 60 * S, 'Display', 120 * sc, withA(R.grade === 'S' ? C.Teal : C.Amber, GA), 'center', 4);
			const t2 = R.tip;
			let next;
			if (t2 < 32) next = `C at $32  ·  $${(32 - t2).toFixed(2)} to go`;
			else if (t2 < 48) next = `B at $48  ·  $${(48 - t2).toFixed(2)} to go`;
			else if (t2 < 65) next = `A at $65  ·  $${(65 - t2).toFixed(2)} to go`;
			else if (t2 < 85) next = `S at $85  ·  $${(85 - t2).toFixed(2)} to go`;
			else next = 'TOP GRADE';
			const hint = R.condition < 85 ? 'brace late for feather landings' : (R.time > 80 ? 'the stairs, the alley and the dock are faster' : 'every second is a dollar');
			this.text(`${next}   ·   ${hint}`, cx, Y + 150 * S, 'Medium', 20, withA(C.Dim, GA), 'center', 1, 1);
			if (G.newBest) this.text('NEW BEST', cx, Y + 96 * S, 'HeavyItalic', 34, withA(C.Teal, GA * (0.7 + 0.3 * Math.sin(this.clock * 6))), 'center', 2, 4);
			else if (G.hasBest) this.text(`BEST  $${G.best.tip.toFixed(2)}  ${G.best.grade}`, cx, Y + 100 * S, 'Semi', 24, withA(C.Dim, GA), 'center', 1, 3);
			this.text('R  RIDE AGAIN', cx, H - 110 * S, 'Bold', 28, withA(C.Teal, GA * (0.6 + 0.4 * Math.sin(this.clock * 3))), 'center', 2, 5, 'again');
		}
	}

	drawSettings(G) {
		const S = this.S, W = this.W, H = this.H;
		this.rect(0, 0, W, H, [0, 0, 0.01, 0.78]);
		this.cover([0, 0, 0.01, 0.78]);
		const cx = W * 0.5;
		const rowW = 760 * S;
		let Y = H * 0.07;
		// The browser build has a few more rows than Unreal's; tighten the rows a little so they fit.
		const rowH = 32 * S;
		this.text('SETTINGS', cx, Y, 'Display', 64, C.Ink, 'center', 3, 6);
		Y += 92 * S;
		G.settingsRows.forEach((R, i) => {
			if (R.section) {
				Y += 8 * S;
				this.text(R.section, cx - rowW * 0.5, Y, 'Semi', 16, withA(C.Amber, 0.8), 'left', 0, 4);
				Y += 24 * S;
			}
			const sel = G.settingsIndex === i;
			if (R.action) {
				Y += 10 * S;
				if (sel) this.rect(cx - rowW * 0.5 - 14 * S, Y - 2 * S, rowW + 28 * S, rowH, [1, 0.7, 0.22, 0.12]);
				this.text(R.label, cx, Y, 'Bold', 24, sel ? C.Amber : C.Dim, 'center', 1, 4, `set:${i}:0`);
			} else {
				this.rect(cx - rowW * 0.5 - 14 * S, Y - 2 * S, rowW + 28 * S, rowH, sel ? [1, 0.7, 0.22, 0.12] : [0, 0, 0, 0.001], `set:${i}:1`);
				this.text(R.label, cx - rowW * 0.5, Y, 'Medium', 23, sel ? C.Ink : C.Dim, 'left', 1);
				const v = R.value();
				this.text(sel ? `<  ${v}  >` : v, cx + rowW * 0.5, Y, 'Bold', 23, sel ? C.Amber : C.Ink, 'right', 1, 1);
			}
			Y += rowH;
		});
		this.text('UP / DOWN  choose     LEFT / RIGHT  change     ESC / B  back', cx, H - 50 * S, 'Medium', 18, C.Dim, 'center', 1, 2);
		this.text(`${Math.round(G.measuredFps)} FPS`, W - 30 * S, 30 * S, 'Semi', 18, C.Dim, 'right', 1, 2);
	}

	drawPause(G) {
		const S = this.S, W = this.W, H = this.H;
		this.rect(0, 0, W, H, [0, 0, 0.01, 0.6]);
		this.cover([0, 0, 0.01, 0.6]);
		this.text('PAUSED', W * 0.5, H * 0.3, 'Display', 80, C.Ink, 'center', 3, 6);
		const items = ['RESUME', 'RESTART', 'SETTINGS', 'QUIT TO TITLE'];
		items.forEach((it, i) => {
			const sel = G.pauseIndex === i;
			this.rect(W * 0.5 - 200 * S, H * 0.45 + i * 56 * S + 4 * S, 400 * S, 46 * S, sel ? [1, 0.7, 0.22, 0.12] : [0, 0, 0, 0.001], `pause:${i}`);
			this.text(it, W * 0.5, H * 0.45 + i * 56 * S, 'Bold', 34, sel ? C.Amber : C.Dim, 'center', 2, 4);
		});
	}
}
