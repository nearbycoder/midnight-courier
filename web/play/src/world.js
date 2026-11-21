// The neighbourhood (port of AMcWorld): loads the packed city, builds render batches (per grid cell and
// material), the collision mesh, the light pool (nearest lights of ~230 become real lights), rain, sky,
// the drop-off beacon and lightning. Also builds the three.js objects for the bike and its ghost.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { Collision } from './collision.js';
import { litMaterial, rainMaterial, beaconMaterial, skyMaterial, ghostMaterial, sprayMaterial, shared } from './materials.js';
import { DEG, randRange, rotatorVector, rotatorQuat, toThreeQuat, setUE } from './math.js';

const ASSETS = 'assets/';
const REFLECTED = new Set(['M_Facade', 'M_FacadePlain', 'M_Roof', 'M_Neon', 'M_Lamp', 'M_Glow', 'M_Shop', 'M_Concrete', 'M_Water']);

/** Fetch with progress (bytes) for the loading bar. */
async function fetchBuffer(url, onBytes) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	if (!res.body || !res.body.getReader) { const b = await res.arrayBuffer(); onBytes(b.byteLength); return b; }
	const reader = res.body.getReader();
	const chunks = []; let n = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value); n += value.length; onBytes(value.length);
	}
	const out = new Uint8Array(n); let o = 0;
	for (const c of chunks) { out.set(c, o); o += c.length; }
	return out.buffer;
}

function renameAttributes(geo) {
	const ren = { color: 'aCol', uv: 'aUv0', uv1: 'aUv1' };
	for (const [a, b] of Object.entries(ren)) {
		if (geo.attributes[a]) { geo.setAttribute(b, geo.attributes[a]); geo.deleteAttribute(a); }
	}
}

/** Make a set of geometries mergeable: same attributes, same array types (fall back to float). */
function harmonize(geos) {
	const names = new Set();
	for (const g of geos) for (const n of Object.keys(g.attributes)) names.add(n);
	for (const n of names) {
		const attrs = geos.map((g) => g.attributes[n]);
		const ref = attrs.find(Boolean);
		const same = attrs.every((a) => a && a.array.constructor === ref.array.constructor && a.normalized === ref.normalized && a.itemSize === ref.itemSize);
		if (same) continue;
		geos.forEach((g, i) => {
			const a = attrs[i];
			const count = g.attributes.position.count;
			const out = new Float32Array(count * ref.itemSize);
			if (a) {
				for (let k = 0; k < count; k++) for (let c = 0; c < ref.itemSize; c++) out[k * ref.itemSize + c] = a.getComponent(k, c);
			} else {
				const def = n === 'aCol' ? [1, 1, 1, 0.5] : n === 'normal' ? [0, 1, 0] : [0, 0, 0, 0];
				for (let k = 0; k < count; k++) for (let c = 0; c < ref.itemSize; c++) out[k * ref.itemSize + c] = def[c] ?? 0;
			}
			g.setAttribute(n, new THREE.BufferAttribute(out, ref.itemSize));
		});
	}
}

function matName(m) { return (m && m.name ? m.name : 'M_VC').split('.')[0]; }

export class World {
	constructor(scene) {
		this.scene = scene;
		this.startPos = new THREE.Vector3();
		this.startYaw = 0;
		this.checkpoints = [];
		this.goalPos = new THREE.Vector3();
		this.routes = {};
		this.mapLines = [];
		this.water = [];
		this.lightning = 0;
		this.thunderPending = false;
		this.thunderDelay = 0;
		this.nextLightning = 25;
		this.focus = new THREE.Vector3();
		this.focusVel = new THREE.Vector3();
		this.lampPos = new THREE.Vector3();
		this.lampDir = new THREE.Vector3(1, 0, 0);
		this.goalActive = true;
		this.batches = [];
	}

	async load(onProgress) {
		const files = ['level.json', 'city_s.glb', 'city_d.glb', 'props.glb', 'rider.glb'];
		const sizes = { 'level.json': 60e3, 'city_s.glb': 2.4e6, 'city_d.glb': 5.9e6, 'props.glb': 0.3e6, 'rider.glb': 0.2e6 };
		const total = Object.values(sizes).reduce((a, b) => a + b, 0);
		let got = 0;
		const bump = (n) => { got += n; onProgress(Math.min(0.9, got / total * 0.9)); };
		const bufs = await Promise.all(files.map((f) => fetchBuffer(ASSETS + f, bump)));
		this.level = JSON.parse(new TextDecoder().decode(bufs[0]));
		await MeshoptDecoder.ready;
		const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
		const parse = (buf) => new Promise((res, rej) => loader.parse(buf, ASSETS, res, rej));
		const [cityS, cityD, props, rider] = await Promise.all([parse(bufs[1]), parse(bufs[2]), parse(bufs[3]), parse(bufs[4])]);
		onProgress(0.93);
		this.props = props.scene;
		this.riderScene = rider.scene;
		this.props.traverse((o) => { if (o.isMesh) renameAttributes(o.geometry); });
		this.riderScene.traverse((o) => { if (o.isMesh) renameAttributes(o.geometry); });
		this.parseLevel();
		this.buildCity(cityS.scene, cityD.scene);
		onProgress(0.97);
		this.buildWeather();
		this.buildLights();
	}

	parseLevel() {
		const J = this.level;
		const cm = (a) => new THREE.Vector3(a[0] / 100, a[1] / 100, a[2] / 100);
		for (const A of J.water) {
			this.water.push({ x0: Math.min(A[0], A[2]) / 100, y0: Math.min(A[1], A[3]) / 100, x1: Math.max(A[0], A[2]) / 100, y1: Math.max(A[1], A[3]) / 100, z: A[4] / 100 });
		}
		this.waterZ = Math.max(...this.water.map((w) => w.z));
		this.startPos.copy(cm(J.start.pos));
		this.startYaw = J.start.yaw;
		for (const c of J.checkpoints) {
			this.checkpoints.push({ name: c.name, pos: cm(c.pos), yaw: c.yaw, radius: c.radius / 100, halfWidth: (c.halfwidth ?? c.radius) / 100 });
		}
		const g = this.checkpoints[this.checkpoints.length - 1];
		this.goalPos.copy(g.pos); this.goalRadius = g.radius;
		for (const [name, pts] of Object.entries(J.routes)) {
			this.routes[name] = pts.map((A) => ({ pos: cm(A), speed: A[3], brace: !!((A[4] | 0) & 1), hop: !!((A[4] | 0) & 2) }));
		}
		this.mapLines = (J.map || []).map((m) => ({ kind: m.kind, pts: m.pts.map((p) => [p[0] / 100, p[1] / 100]) }));
	}

	buildCity(sceneS, sceneD) {
		sceneS.updateMatrixWorld(true);
		sceneD.updateMatrixWorld(true);
		const groups = new Map();
		const colPos = [], colIdx = [];
		let colVerts = 0;
		const v = new THREE.Vector3();
		const take = (root, solid) => {
			root.traverse((o) => {
				if (!o.isMesh) return;
				let node = o;
				while (node.parent && !/^SM_City_/.test(node.name)) node = node.parent;
				const m = /SM_City_[SD]_(\d+)_(\d+)/.exec(node.name);
				// Batch 2x2 grid cells per material: fewer draw calls, still coarse frustum culling.
				const cell = m ? `${Math.floor(Number(m[1]) / 2)}_${Math.floor(Number(m[2]) / 2)}` : 'x';
				const src = o.geometry;
				const mat = matName(o.material);
				// Dequantize into world-space float positions.
				const P = src.attributes.position, n = P.count;
				const pos = new Float32Array(n * 3);
				for (let i = 0; i < n; i++) {
					v.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld);
					pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
				}
				const geo = new THREE.BufferGeometry();
				geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
				for (const [name, attr] of Object.entries(src.attributes)) if (name !== 'position') geo.setAttribute(name, attr);
				geo.setIndex(src.index);
				renameAttributes(geo);
				const key = cell + '|' + mat;
				if (!groups.has(key)) groups.set(key, { mat, geos: [] });
				groups.get(key).geos.push(geo);
				if (solid) {
					// Collision in Unreal space: (x, y, z)ue = (x, z, y)three.
					const cp = new Float32Array(n * 3);
					for (let i = 0; i < n; i++) { cp[i * 3] = pos[i * 3]; cp[i * 3 + 1] = pos[i * 3 + 2]; cp[i * 3 + 2] = pos[i * 3 + 1]; }
					colPos.push(cp);
					const idx = src.index.array;
					const ci = new Uint32Array(idx.length);
					for (let i = 0; i < idx.length; i++) ci[i] = idx[i] + colVerts;
					colIdx.push(ci);
					colVerts += n;
				}
			});
		};
		take(sceneS, true);
		take(sceneD, false);

		// Collision.
		const allP = new Float32Array(colVerts * 3);
		let o = 0; for (const a of colPos) { allP.set(a, o); o += a.length; }
		const nIdx = colIdx.reduce((s, a) => s + a.length, 0);
		const allI = new Uint32Array(nIdx);
		o = 0; for (const a of colIdx) { allI.set(a, o); o += a.length; }
		this.collision = new Collision(allP, allI);

		// Render batches.
		this.city = new THREE.Group();
		this.city.name = 'city';
		for (const [key, g] of groups) {
			if (g.geos.length > 1) harmonize(g.geos);
			const geo = g.geos.length === 1 ? g.geos[0] : mergeGeometries(g.geos, false);
			if (!geo) { console.warn('merge failed', key); continue; }
			geo.computeBoundingSphere();
			geo.computeBoundingBox();
			const mesh = new THREE.Mesh(geo, litMaterial(g.mat));
			mesh.name = key;
			mesh.matrixAutoUpdate = false;
			const emissiveOnly = g.mat === 'M_Neon' || g.mat === 'M_Lamp' || g.mat === 'M_Glow' || g.mat === 'M_Shop';
			mesh.castShadow = !emissiveOnly && g.mat !== 'M_Water';
			mesh.receiveShadow = !emissiveOnly;
			mesh.userData.mat = g.mat;
			// Layer 1 = what the wet-ground reflection renders: big and bright things only.
			if (REFLECTED.has(g.mat)) mesh.layers.enable(1);
			this.city.add(mesh);
			this.batches.push(mesh);
		}
		this.scene.add(this.city);
		this.stats = { batches: this.batches.length, colTris: nIdx / 3 };
	}

	propMesh(name) {
		const src = this.props.getObjectByName(name);
		const wrap = new THREE.Group();
		wrap.name = name;
		const c = src.clone(true);
		wrap.add(c);
		c.traverse((o) => {
			if (!o.isMesh) return;
			const mn = matName(o.material);
			o.material = mn === 'M_Rain' ? rainMaterial() : mn === 'M_Beacon' ? beaconMaterial() : litMaterial(mn);
			o.castShadow = mn !== 'M_Beacon' && mn !== 'M_Rain';
			o.receiveShadow = true;
		});
		return wrap;
	}

	buildWeather() {
		// Moon + sky light. Unreal: moon 0.06 lux, sky light 0.25 on a grey cubemap (plus Lumen bounce,
		// which a little extra ambient stands in for).
		this.moon = new THREE.DirectionalLight(new THREE.Color(0.55, 0.65, 1.0), 0.06);
		const md = rotatorVector(-38, 125);
		this.moon.position.set(-md.x, -md.z, -md.y).multiplyScalar(100);
		this.moon.target.position.set(0, 0, 0);
		this.scene.add(this.moon, this.moon.target);
		this.moon.layers.enable(1);
		this.ambient = new THREE.HemisphereLight(new THREE.Color(0.35, 0.42, 0.6), new THREE.Color(0.16, 0.14, 0.13), 0.9);
		this.scene.add(this.ambient);
		this.ambient.layers.enable(1);
		this.scene.fog = new THREE.FogExp2(new THREE.Color(0.012, 0.016, 0.026), 0.0055);

		this.sky = new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 16), skyMaterial());
		this.sky.frustumCulled = false;
		this.sky.renderOrder = -10;
		this.sky.layers.enable(1);
		this.scene.add(this.sky);

		this.rain = this.propMesh('SM_RainStreaks');
		this.rain.traverse((o) => { if (o.isMesh) { o.frustumCulled = false; o.renderOrder = 10; } });
		this.scene.add(this.rain);

		this.beacon = this.propMesh('SM_Beacon');
		this.beacon.position.set(this.goalPos.x, this.goalPos.z, this.goalPos.y);
		this.beacon.traverse((o) => o.layers.enable(1));
		this.scene.add(this.beacon);
	}

	buildLights() {
		this.levelLights = this.level.lights.map((L) => {
			const pos = new THREE.Vector3(L.pos[0] / 100, L.pos[2] / 100, L.pos[1] / 100); // three space
			let dir = null;
			if (L.rot) { const d = rotatorVector(L.rot[0], L.rot[1]); dir = new THREE.Vector3(d.x, d.z, d.y); }
			let kind = L.kind;
			let inner = 0, outer = 0;
			if (kind === 'spot') { inner = L.cone[0]; outer = L.cone[1]; }
			if (kind === 'rect') { kind = 'spot'; inner = 35; outer = 80; }
			return {
				kind, pos, dir, inner, outer,
				color: new THREE.Color(L.color[0], L.color[1], L.color[2]),
				intensity: L.intensity, radius: L.radius / 100, fog: L.fog ?? 1, d: 0, w: 0,
			};
		});
		this.pointLights = [];
		this.spotLights = [];
	}

	/** (Re)creates the light pool. Changing the count recompiles shaders, so only do it on settings change. */
	setLightPool(nPoint, nSpot) {
		for (const l of [...this.pointLights, ...this.spotLights]) { this.scene.remove(l); if (l.target) this.scene.remove(l.target); l.dispose?.(); }
		this.pointLights = []; this.spotLights = [];
		for (let i = 0; i < nPoint; i++) {
			const l = new THREE.PointLight(0xffffff, 0, 10, 2);
			l.layers.enable(1);
			this.scene.add(l); this.pointLights.push(l);
		}
		for (let i = 0; i < nSpot; i++) {
			const l = new THREE.SpotLight(0xffffff, 0, 10, 0.5, 0.5, 2);
			l.layers.enable(1);
			this.scene.add(l, l.target); this.spotLights.push(l);
		}
		this.lightFrame = 0;
	}

	/** Pick the nearest lights to a point a little ahead of the camera. */
	updateLights(camPos, camDir, force = false) {
		if (!force && (this.lightFrame++ % 3) !== 0) return;
		const f = new THREE.Vector3().copy(camPos).addScaledVector(camDir, 12);
		for (const L of this.levelLights) L.d = L.pos.distanceTo(f) - L.radius * 0.35;
		const assign = (pool, kind) => {
			const cands = this.levelLights.filter((L) => L.kind === kind).sort((a, b) => a.d - b.d);
			const cut = cands.length > pool.length ? cands[pool.length].d : Infinity;
			for (let i = 0; i < pool.length; i++) {
				const l = pool[i], L = cands[i];
				if (!L) { l.intensity = 0; l.visible = false; continue; }
				const fade = cut === Infinity ? 1 : THREE.MathUtils.smoothstep(cut - L.d, 0, 6);
				l.visible = true;
				l.position.copy(L.pos);
				l.color.copy(L.color);
				l.intensity = L.intensity * fade;
				l.distance = L.radius;
				if (kind === 'spot') {
					l.angle = Math.min(L.outer, 89) * DEG;
					l.penumbra = THREE.MathUtils.clamp(1 - L.inner / Math.max(L.outer, 1), 0, 1);
					l.target.position.copy(L.pos).add(L.dir);
					l.target.updateMatrixWorld();
				}
			}
		};
		assign(this.pointLights, 'point');
		assign(this.spotLights, 'spot');
		// For the fog halos: the nearest lights of any kind.
		this.haloLights = [...this.levelLights].sort((a, b) => a.d - b.d).slice(0, 24);
	}

	setFocus(camPos, vel) { this.focus.copy(camPos); this.focusVel.copy(vel); }
	setLamp(pos, dir) { this.lampPos.copy(pos); this.lampDir.copy(dir); }
	setGoalActive(on) { this.goalActive = on; this.beacon.visible = on; }

	tick(dt, time) {
		// Rain material wraps streaks around the camera; feed it the velocity and the head lamp.
		shared.uCamVel.value.set(this.focusVel.x * 100, this.focusVel.y * 100, this.focusVel.z * 100);
		shared.uLampPos.value.set(this.lampPos.x * 100, this.lampPos.y * 100, this.lampPos.z * 100);
		shared.uLampDir.value.copy(this.lampDir);
		this.sky.position.set(this.focus.x, this.focus.z, this.focus.y);
		shared.uLightning.value = this.lightning;
		// Lightning: rare, far away; a flash of the moon light and the sky, thunder seconds later.
		this.nextLightning -= dt;
		if (this.nextLightning <= 0) {
			this.lightning = 1;
			this.nextLightning = randRange(18, 40);
			this.thunderPending = true;
			this.thunderDelay = randRange(1.2, 3.5);
		}
		if (this.lightning > 0) {
			const flicker = ((time * 13) % 1) > 0.4 ? 1 : 0.35;
			this.lightning = Math.max(0, this.lightning - dt * 2.2);
			this.moon.intensity = 0.06 + 2.5 * this.lightning * flicker;
		} else this.moon.intensity = 0.06;
	}

	// =================================================================================================
	// Bike visuals
	// =================================================================================================
	buildBikeView({ ghost = false } = {}) {
		const root = new THREE.Group();
		root.name = ghost ? 'ghost' : 'bike';
		const frame = new THREE.Group();
		root.add(frame);
		const parts = {};
		const add = (key, mesh, parent) => { parts[key] = this.propMesh(mesh); parent.add(parts[key]); };
		add('frame', 'SM_BikeFrame', frame);
		add('fork', 'SM_BikeFork', frame);
		add('wheelF', 'SM_BikeWheel', frame);
		add('wheelR', 'SM_BikeWheel', frame);
		add('crank', 'SM_BikeCrank', frame);
		add('pedalL', 'SM_BikePedal', frame);
		add('pedalR', 'SM_BikePedal', frame);
		add('pack', 'SM_Package', root);

		// Skinned rider.
		const riderRoot = SkeletonUtils.clone(this.riderScene);
		riderRoot.updateMatrixWorld(true);
		const bones = {};
		const restUE = {};
		let skinned = null;
		riderRoot.traverse((o) => {
			if (o.isSkinnedMesh) { skinned = o; o.frustumCulled = false; }
			if (o.isBone) {
				const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
				o.matrixWorld.decompose(p, q, s);
				bones[o.name] = { bone: o, restPos3: p, restQuat3: q, csPos: p.clone(), csQuat: q.clone(), posed: false };
				restUE[o.name] = new THREE.Vector3(p.x * 100, p.z * 100, p.y * 100);
			}
		});
		riderRoot.traverse((o) => { if (o.isMesh) { o.material = litMaterial(matName(o.material)); o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
		// Order bones parents-first.
		const order = [];
		riderRoot.traverse((o) => { if (o.isBone) order.push(o.name); });
		const _m = new THREE.Matrix4(), _pm = new THREE.Matrix4(), _s = new THREE.Vector3(1, 1, 1);
		const rider = {
			root: riderRoot, bones, restUE,
			apply() {
				for (const name of order) {
					const b = bones[name];
					if (name === 'root') continue;
					_m.compose(b.csPos, b.csQuat, _s);
					const parent = b.bone.parent;
					const pb = parent && parent.isBone ? bones[parent.name] : null;
					if (pb) { _pm.compose(pb.csPos, pb.csQuat, _s).invert(); _m.premultiply(_pm); }
					_m.decompose(b.bone.position, b.bone.quaternion, b.bone.scale);
				}
			},
		};
		frame.add(riderRoot);

		if (ghost) {
			const gm = ghostMaterial();
			root.traverse((o) => { if (o.isMesh) { o.material = gm; o.castShadow = false; o.receiveShadow = false; } });
		}
		const view = { root, frame, parts, rider };

		if (!ghost) {
			// Lights riding with the courier (Unreal: head lamp 5200 cd, tail 6 cd, a soft blue fill).
			const head = new THREE.SpotLight(new THREE.Color(1, 0.93, 0.82), 5200, 42, 24 * DEG, 1 - 9 / 24, 2);
			setUE(head, new THREE.Vector3(0.58, 0, 0.40));
			const hd = rotatorVector(-9, 0);
			head.target.position.set(0.58 + hd.x, 0.40 + hd.z, hd.y);
			head.castShadow = true;
			head.shadow.mapSize.set(2048, 2048);
			head.shadow.camera.near = 0.3;
			head.shadow.camera.far = 42;
			head.shadow.bias = -0.0004;
			head.shadow.normalBias = 0.02;
			frame.add(head, head.target);
			const tail = new THREE.SpotLight(new THREE.Color(1, 0.05, 0.03), 6, 4, 55 * DEG, 0.5, 2);
			setUE(tail, new THREE.Vector3(-0.64, 0, 0.30));
			const td = rotatorVector(-25, 180);
			tail.target.position.set(-0.64 + td.x, 0.30 + td.z, td.y);
			frame.add(tail, tail.target);
			const fill = new THREE.PointLight(new THREE.Color(0.55, 0.7, 1.0), 2.5, 4.2, 2);
			setUE(fill, new THREE.Vector3(-1.6, 0.6, 1.9));
			frame.add(fill);
			view.lights = { head, tail, fill };

			// Spray.
			const geo = new THREE.BufferGeometry();
			geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(28 * 3), 3));
			geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(28), 1));
			geo.setAttribute('aOpacity', new THREE.BufferAttribute(new Float32Array(28), 1));
			const spray = new THREE.Points(geo, sprayMaterial());
			spray.frustumCulled = false;
			spray.renderOrder = 5;
			view.spray = spray;
			this.scene.add(spray);
		}
		// The courier shows up in puddles too (and its lights must exist in that pass).
		root.traverse((o) => o.layers.enable(1));
		this.scene.add(root);
		return view;
	}
}

/** Push the bike's spray puffs into the points geometry. */
export function updateSprayView(view, bike) {
	if (!view.spray) return;
	const g = view.spray.geometry;
	const P = g.attributes.position.array, S = g.attributes.aSize.array, O = g.attributes.aOpacity.array;
	bike.puffs.forEach((p, i) => {
		P[i * 3] = p.pos.x; P[i * 3 + 1] = p.pos.z; P[i * 3 + 2] = p.pos.y;
		const alive = p.age < p.life;
		const F = alive ? p.age / p.life : 1;
		S[i] = alive ? p.size * (1 + F * 2.2) : 0;
		O[i] = alive ? 0.22 * (1 - F) * Math.min(1, F * 8) : 0;
	});
	g.attributes.position.needsUpdate = true;
	g.attributes.aSize.needsUpdate = true;
	g.attributes.aOpacity.needsUpdate = true;
}
