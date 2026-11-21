// Drives the installed Google Chrome with playwright-core against a local static server of web/:
// screenshots the title, settings, the autopilot rides (?auto=main, ?auto=short) and their results into
// tools/shots/, checks a few aspect ratios for HUD overlap, and fails on console errors.
//
//   node tools/shot.mjs                 # everything, headless
//   node tools/shot.mjs main --headed   # just the main route, in a visible window (real GPU timing)
//   options: title | main | short | aspect | quality (any subset), --headed, --quality=0..3, --port=8123
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(TOOLS, '../..');
const SHOTS = path.join(TOOLS, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const args = process.argv.slice(2);
const opt = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const headed = args.includes('--headed');
const only = args.filter((a) => !a.startsWith('--'));
const want = (k) => only.length === 0 || only.includes(k);
const quality = opt('quality', null);

// ---- static server ------------------------------------------------------------------------------------
const MIME = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
	'.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain',
};
const server = http.createServer((req, res) => {
	let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	if (p.endsWith('/')) p += 'index.html';
	const f = path.join(WEB, p);
	if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
	res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
	fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(Number(opt('port', 0)), '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/play/`;
console.log('serving', WEB, 'at', BASE);

const browser = await chromium.launch({
	channel: 'chrome', headless: !headed,
	args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const errors = [];
const results = {};

async function open(url, viewport = { width: 1920, height: 1080 }) {
	const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
	const page = await ctx.newPage();
	page.on('console', (m) => {
		const t = m.text();
		if (m.type() === 'error') { errors.push(`${url}: ${t}`); console.log('  [console.error]', t); }
		else if (/^MC_/.test(t)) console.log('  ', t);
	});
	page.on('pageerror', (e) => { errors.push(`${url}: ${e.message}`); console.log('  [pageerror]', e.message); });
	await page.goto(BASE + url);
	await page.waitForFunction(() => window.__mc && !document.getElementById('loading'), null, { timeout: 120000 });
	return { ctx, page };
}
const shot = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); console.log('  shot', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** HUD overlap check: glyph ink boxes of visible texts must not intersect each other or cross panel edges. */
const checkOverlap = (page) => page.evaluate(() => {
			const els = [...document.querySelectorAll('#hud .t')].filter((e) => e.style.display !== 'none' && e.textContent.trim() && parseFloat(getComputedStyle(e).color.split(',')[3] ?? '1') > 0.05);
			// Glyph ink boxes (the CSS line box of a big display font is much taller than its letters).
			const ctx = document.createElement('canvas').getContext('2d');
			const boxes = els.map((e) => {
				const r = e.getBoundingClientRect();
				ctx.font = getComputedStyle(e).font;
				const m = ctx.measureText(e.textContent);
				const content = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
				const base = r.top + (r.height - content) / 2 + m.fontBoundingBoxAscent;
				return { t: e.textContent, r: { left: r.left, right: r.right, top: base - m.actualBoundingBoxAscent, bottom: base + m.actualBoundingBoxDescent } };
			});
			const bad = [];
			// Panels drawn by the HUD: texts may sit fully inside them, never across their edges.
			const S = window.__game.hud.S, W = innerWidth, H = innerHeight;
			const riding = ['riding', 'countdown', 'respawning'].includes(window.__game.phase) && !window.__game.paused;
			const panels = !riding ? [] : [
				{ t: 'minimap', r: { left: 50 * S, right: 270 * S, top: H - 440 * S, bottom: H - 220 * S } },
				{ t: 'package panel', r: { left: W - 50 * S - 316 * S, right: W - 34 * S, top: H - 214 * S, bottom: H - 50 * S } },
			];
			for (const p of panels) for (const b of boxes) {
				const a = p.r, r = b.r;
				const ix = Math.min(a.right, r.right) - Math.max(a.left, r.left), iy = Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top);
				const inside = r.left >= a.left - 1 && r.right <= a.right + 1 && r.top >= a.top - 1 && r.bottom <= a.bottom + 1;
				if (ix > 2 && iy > 2 && !inside) bad.push(`${p.t} / ${b.t}`);
			}
			if (panels.length && panels[0].r.right > panels[1].r.left && panels[0].r.bottom > panels[1].r.top) bad.push('minimap / package panel');
			for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i].r, b = boxes[j].r;
				const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
				if (ix > 2 && iy > 4) bad.push(`${boxes[i].t} / ${boxes[j].t}`);
			}
			for (const b of boxes) if (b.r.left < -1 || b.r.right > innerWidth + 1 || b.r.top < -1 || b.r.bottom > innerHeight + 1) bad.push(`offscreen: ${b.t}`);
			return [...new Set(bad)];
		});
const mc = (page) => page.evaluate(() => ({ ...window.__mc, info: undefined }));

async function ride(route) {
	console.log(`== ride ${route}`);
	const q = quality !== null ? `&quality=${quality}` : '';
	const { ctx, page } = await open(`?auto=${route}&mute${q}`);
	const marks = route === 'main' ? [2, 12, 30, 48, 66, 84] : [2, 10, 22, 34, 46, 58];
	let k = 0;
	const t0 = Date.now();
	let s;
	for (;;) {
		s = await mc(page);
		if (k < marks.length && s.runTime >= marks[k]) { await shot(page, `${route}_${String(marks[k]).padStart(3, '0')}s`); k++; }
		if (s.phase === 'delivered' || s.phase === 'failed') break;
		if (Date.now() - t0 > 240000) { errors.push(`${route}: timed out at ${s.runTime.toFixed(1)} s, phase ${s.phase}`); break; }
		await sleep(150);
	}
	await sleep(4500);
	await shot(page, `${route}_results`);
	const ov = await checkOverlap(page);
	if (ov.length) { console.log('  overlaps:', ov.join(' | ')); errors.push(`${route} results overlap: ${ov.join(' | ')}`); }
	s = await mc(page);
	results[route] = { phase: s.phase, time: s.result.time, condition: s.result.condition, tip: s.result.tip, grade: s.result.grade, crashes: s.result.crashes, perf: s.perf, res: s.res };
	console.log('  result', JSON.stringify(results[route]));
	if (route === 'main' && s.phase !== 'delivered') errors.push(`main route not delivered (${s.phase})`);
	if (route === 'main' && s.phase === 'delivered') {
		// Ride again: the best run now rides along as a ghost.
		await page.keyboard.press('KeyR');
		await page.waitForFunction(() => window.__mc.runTime > 9, null, { timeout: 30000 });
		const ghost = await page.evaluate(() => window.__game.isGhostVisible());
		await shot(page, 'main_ghost');
		if (!ghost) errors.push('ghost not visible on the second run');
	}
	await ctx.close();
}

if (want('title')) {
	console.log('== title + settings');
	const { ctx, page } = await open('?mute');
	await sleep(2500);
	await shot(page, 'title');
	await page.keyboard.press('ArrowDown'); await sleep(150);
	await page.keyboard.press('Enter'); await sleep(600);
	await shot(page, 'settings');
	await page.keyboard.press('Escape'); await sleep(300);
	await page.keyboard.press('ArrowUp'); await sleep(100);
	await page.keyboard.press('Enter'); await sleep(900);
	await shot(page, 'countdown');
	await page.keyboard.down('KeyW'); await sleep(3500);
	await shot(page, 'riding_manual');
	await page.keyboard.up('KeyW');
	await page.keyboard.press('Escape'); await sleep(400);
	await shot(page, 'pause');
	await ctx.close();
}

if (want('aspect')) {
	for (const [w, h] of [[1680, 1050], [1280, 1024], [2560, 1080], [900, 1100], [700, 900]]) {
		console.log(`== aspect ${w}x${h}`);
		const { ctx, page } = await open('?mute&ride&fresh', { width: w, height: h });
		await page.keyboard.down('KeyW'); await sleep(3500); await page.keyboard.up('KeyW');
		await shot(page, `aspect_${w}x${h}_ride`);
		const overlaps = await checkOverlap(page);
		if (overlaps.length) { console.log('  overlaps:', overlaps.join(' | ')); errors.push(`${w}x${h} overlap: ${overlaps.join(' | ')}`); }
		results[`aspect_${w}x${h}`] = overlaps;
		await page.evaluate(() => { window.__game.phase = 'title'; window.__game.phaseTime = 2; window.__game.titleIndex = 0; });
		await sleep(400);
		await shot(page, `aspect_${w}x${h}_title`);
		await ctx.close();
	}
}

if (want('quality')) {
	for (const qn of [0, 1, 2, 3]) {
		console.log(`== quality ${qn}`);
		const { ctx, page } = await open(`?mute&ride&fresh&quality=${qn}`);
		await page.keyboard.down('KeyW'); await sleep(4000); await page.keyboard.up('KeyW');
		await shot(page, `quality_${qn}`);
		await ctx.close();
	}
}

if (want('main')) await ride('main');
if (want('short')) await ride('short');

await browser.close();
server.close();
fs.writeFileSync(path.join(SHOTS, 'summary.json'), JSON.stringify({ results, errors }, null, 1));
console.log('\nsummary', JSON.stringify(results, null, 1));
if (errors.length) { console.log('\nFAILED:\n' + errors.join('\n')); process.exit(1); }
console.log('OK');
