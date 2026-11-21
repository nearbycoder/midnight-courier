// Keyboard + gamepad state (standard gamepad mapping).
const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Tab']);

export class Input {
	constructor() {
		this.keys = new Set();
		this.pad = null;
		this.onFirstGesture = null;
		this.lastDevice = 'keyboard';
		const gesture = () => { if (this.onFirstGesture) { const f = this.onFirstGesture; this.onFirstGesture = null; f(); } };
		window.addEventListener('keydown', (e) => {
			if (PREVENT.has(e.code)) e.preventDefault();
			if (e.code === 'Escape' && document.fullscreenElement) { /* browser leaves full screen itself */ }
			this.keys.add(e.code);
			this.lastDevice = 'keyboard';
			gesture();
		});
		window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
		window.addEventListener('blur', () => this.keys.clear());
		window.addEventListener('pointerdown', gesture);
		window.addEventListener('touchstart', gesture, { passive: true });
	}
	key(code) { return this.keys.has(code); }
	poll() {
		this.pad = null;
		const pads = navigator.getGamepads ? navigator.getGamepads() : [];
		for (const p of pads) if (p && p.connected) { this.pad = p; break; }
		if (this.pad && (this.pad.buttons.some((b) => b.pressed) || this.pad.axes.some((a) => Math.abs(a) > 0.3))) {
			this.lastDevice = 'gamepad';
			if (this.onFirstGesture) { const f = this.onFirstGesture; this.onFirstGesture = null; f(); }
		}
	}
	btn(i) { const b = this.pad && this.pad.buttons[i]; return b ? b.pressed : false; }
	btnValue(i) { const b = this.pad && this.pad.buttons[i]; return b ? b.value : 0; }
	axis(i) { return this.pad && this.pad.axes[i] !== undefined ? this.pad.axes[i] : 0; }
	rumble(strength, duration) {
		const a = this.pad && this.pad.vibrationActuator;
		if (a && a.playEffect) a.playEffect('dual-rumble', { duration: duration * 1000, strongMagnitude: strength, weakMagnitude: strength * 0.6 }).catch(() => {});
	}
}
