// Rendering: HDR scene target (MSAA), an optional planar wet-ground reflection, volumetric-ish fog halos
// around the nearest lights, a mip-chain bloom, and a final pass standing in for Unreal's post process
// (manual exposure, filmic/ACES tone curve, teal-shadow / sodium-highlight grade, vignette, fringe, grain).
import * as THREE from 'three';
import { shared } from './materials.js';

const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function fsMaterial(fragmentShader, uniforms, defines = {}) {
	return new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader, uniforms, defines, depthTest: false, depthWrite: false });
}

export const QUALITY = [
	// LOW
	{ name: 'LOW', lines: 720, shadows: false, shadowSize: 1024, refl: false, msaa: 0, points: 6, spots: 4, halos: 8, bloom: true },
	// MEDIUM
	{ name: 'MEDIUM', lines: 900, shadows: true, shadowSize: 1024, refl: false, msaa: 2, points: 8, spots: 6, halos: 16, bloom: true },
	// HIGH
	{ name: 'HIGH', lines: 1080, shadows: true, shadowSize: 2048, refl: true, msaa: 4, points: 10, spots: 6, halos: 24, bloom: true },
	// ULTRA
	{ name: 'ULTRA', lines: 1440, shadows: true, shadowSize: 2048, refl: true, msaa: 4, points: 12, spots: 8, halos: 24, bloom: true },
];

const MAX_HALOS = 24;

export class Renderer {
	constructor(canvas) {
		this.canvas = canvas;
		this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false });
		this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;
		this.gl.toneMapping = THREE.NoToneMapping;
		this.gl.shadowMap.enabled = true;
		this.gl.shadowMap.type = THREE.PCFShadowMap;
		this.gl.autoClear = true;
		this.camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 3000);
		this.reflCam = new THREE.PerspectiveCamera();
		this.reflCam.layers.set(1);
		this.quad = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)));
		this.quad.frustumCulled = false;
		this.quadScene = new THREE.Scene();
		this.quadScene.add(this.quad);
		this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
		this.w = 0; this.h = 0; this.scale = 1;
		this.quality = QUALITY[2];
		this.opts = { shadows: true, refl: true, effects: true };
		this.exposure = 0.75;
		this.fringe = 0.35;
		this.vignette = 0.55;
		this.lightningEv = 0;
		this.time = 0;
		this.halo = { pos: [], col: [], prm: [], dir: [] };
		for (let i = 0; i < MAX_HALOS; i++) { this.halo.pos.push(new THREE.Vector3()); this.halo.col.push(new THREE.Vector3()); this.halo.prm.push(new THREE.Vector3()); this.halo.dir.push(new THREE.Vector3(0, -1, 0)); }
		this.blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
		this.blackTex.needsUpdate = true;
		shared.uReflTex.value = this.blackTex;
		this.buildMaterials();
	}

	buildMaterials() {
		this.haloMat = fsMaterial(/* glsl */`
uniform sampler2D tColor; uniform sampler2D tDepth;
uniform mat4 projInv; uniform mat4 viewInv;
uniform vec3 hPos[${MAX_HALOS}]; uniform vec3 hCol[${MAX_HALOS}]; uniform vec3 hPrm[${MAX_HALOS}]; uniform vec3 hDir[${MAX_HALOS}];
uniform int hCount; uniform float uScatter;
uniform vec3 lampPos; uniform vec3 lampDir; uniform vec3 lampCol; uniform float lampCos;
uniform vec3 fogCol; uniform float fogDensity;
varying vec2 vUv;
void main() {
	vec3 col = texture2D(tColor, vUv).rgb;
	float z = texture2D(tDepth, vUv).x;
	vec4 ndc = vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
	vec4 vp = projInv * ndc; vp /= vp.w;
	vec3 wp = (viewInv * vp).xyz;
	vec3 ro = cameraPos;
	vec3 rd = wp - ro; float L = length(rd); rd /= L;
	L = min(L, 400.0);
	vec3 acc = vec3(0.0);
	for (int i = 0; i < ${MAX_HALOS}; i++) {
		if (i >= hCount) break;
		vec3 D = hPos[i] - ro;
		float b = dot(D, rd);
		// Floor the closest approach (a light right next to the camera would otherwise go to infinity).
		float h2 = max(dot(D, D) - b * b, 1.2);
		float R = hPrm[i].x;
		if (h2 >= R * R) continue;
		float half_ = sqrt(R * R - h2);
		float t0 = max(b - half_, 0.0), t1 = min(b + half_, L);
		if (t1 <= t0) continue;
		float h = sqrt(h2);
		float I = (atan((t1 - b) / h) - atan((t0 - b) / h)) / h;
		// Fade toward the edge of the light's reach (closest approach relative to radius).
		float win = 1.0 - h2 / (R * R); win *= win;
		// Spot lights: weight by the cone at the closest approach.
		float cone = 1.0;
		if (hPrm[i].y > 0.5) {
			vec3 cp = ro + rd * clamp(b, t0, t1);
			vec3 dl = normalize(cp - hPos[i]);
			cone = 0.1 + 0.9 * smoothstep(-0.2, 0.6, dot(dl, hDir[i]));
		}
		// Lights right next to the camera would veil the whole frame; Unreal's fog starts a couple of metres out.
		float near_ = smoothstep(2.0, 9.0, length(D));
		acc += hCol[i] * I * win * cone * near_;
	}
	// Head lamp beam: short march (it is the one light whose cone you look along).
	{
		float tl = min(L, 30.0);
		vec3 b = vec3(0.0);
		// Jittered per pixel (interleaved gradient noise) so the coarse steps don't slice the cone into bands.
		float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
		for (int k = 0; k < 14; k++) {
			float t = (float(k) + jit) / 14.0 * tl;
			vec3 p = ro + rd * t;
			vec3 d = p - lampPos; float dl = length(d);
			float c = smoothstep(lampCos, mix(lampCos, 1.0, 0.6), dot(d / max(dl, 1e-3), lampDir));
			b += c * smoothstep(0.8, 3.0, dl) / (dl * dl + 1.5);   // skip the lamp's own blob around the rider
		}
		acc += lampCol * b * (tl / 14.0);
	}
	// Soft cap so a cluster of lamps can't white out the frame.
	vec3 glow = acc * uScatter;
	col += glow / (1.0 + max(max(glow.r, glow.g), glow.b) * 4.0);
	gl_FragColor = vec4(col, 1.0);
}`, {
			tColor: { value: null }, tDepth: { value: null }, projInv: { value: new THREE.Matrix4() }, viewInv: { value: new THREE.Matrix4() },
			hPos: { value: this.halo.pos }, hCol: { value: this.halo.col }, hPrm: { value: this.halo.prm }, hDir: { value: this.halo.dir }, hCount: { value: 0 },
			uScatter: { value: 0.000028 }, cameraPos: { value: new THREE.Vector3() },
			lampPos: { value: new THREE.Vector3() }, lampDir: { value: new THREE.Vector3(1, 0, 0) }, lampCol: { value: new THREE.Vector3() }, lampCos: { value: Math.cos(24 * Math.PI / 180) },
			fogCol: { value: new THREE.Vector3() }, fogDensity: { value: 0 },
		});
		this.haloMat.fragmentShader = 'uniform vec3 cameraPos;\n' + this.haloMat.fragmentShader;

		this.downMat = fsMaterial(/* glsl */`
uniform sampler2D tSrc; uniform vec2 texel; uniform float threshold; uniform float first;
varying vec2 vUv;
vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * texel).rgb; }
void main() {
	// 13-tap downsample (Jimenez 2014).
	vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
	vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
	vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
	vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
	vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
	if (first > 0.5) {
		float br = max(col.r, max(col.g, col.b));
		float soft = clamp(br - threshold + 0.5, 0.0, 1.0); soft = soft * soft * 0.5;
		float contrib = max(soft, br - threshold) / max(br, 1e-4);
		col *= contrib;
		// Energy clamp: small hot emitters still bloom, big brightly lit surfaces don't flood the frame.
		col = col * (3.0 / max(3.0, max(col.r, max(col.g, col.b))));
	}
	gl_FragColor = vec4(col, 1.0);
}`, { tSrc: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 0.9 }, first: { value: 0 } });

		this.upMat = fsMaterial(/* glsl */`
uniform sampler2D tSrc; uniform sampler2D tBase; uniform vec2 texel; uniform float radius;
varying vec2 vUv;
void main() {
	vec2 t = texel * radius;
	vec3 c = texture2D(tSrc, vUv + vec2(-t.x, t.y)).rgb + texture2D(tSrc, vUv + vec2(0, t.y)).rgb * 2.0 + texture2D(tSrc, vUv + vec2(t.x, t.y)).rgb
		+ texture2D(tSrc, vUv + vec2(-t.x, 0)).rgb * 2.0 + texture2D(tSrc, vUv).rgb * 4.0 + texture2D(tSrc, vUv + vec2(t.x, 0)).rgb * 2.0
		+ texture2D(tSrc, vUv + vec2(-t.x, -t.y)).rgb + texture2D(tSrc, vUv + vec2(0, -t.y)).rgb * 2.0 + texture2D(tSrc, vUv + vec2(t.x, -t.y)).rgb;
	gl_FragColor = vec4(texture2D(tBase, vUv).rgb + c / 16.0, 1.0);
}`, { tSrc: { value: null }, tBase: { value: null }, texel: { value: new THREE.Vector2() }, radius: { value: 1 } });

		this.finalMat = fsMaterial(/* glsl */`
uniform sampler2D tColor; uniform sampler2D tBloom;
uniform float exposure; uniform float bloomI; uniform float fringe; uniform float vignette; uniform float grain;
uniform float time; uniform vec2 res; uniform float hasBloom; uniform float dof; uniform float fade;
varying vec2 vUv;
vec3 aces(vec3 x) {
	// ACES fitted (Stephen Hill): sRGB -> AP1-ish RRT+ODT -> sRGB.
	const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
	const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
	x = IN * x;
	vec3 a = x * (x + 0.0245786) - 0.000090537;
	vec3 b = x * (0.983729 * x + 0.4329510) + 0.238081;
	return clamp(OUT * (a / b), 0.0, 1.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 srgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
void main() {
	vec2 d = vUv - 0.5;
	// Scene fringe (chromatic aberration), stronger toward the edges.
	vec2 off = d * dot(d, d) * fringe * 0.012;
	vec3 col;
	col.r = texture2D(tColor, vUv - off).r;
	col.g = texture2D(tColor, vUv).g;
	col.b = texture2D(tColor, vUv + off).b;
	if (hasBloom > 0.5) col += texture2D(tBloom, vUv).rgb * bloomI;
	col *= exposure;
	// Grade (Unreal: saturation 1.05 blue, contrast 1.08, gamma shadows (.92, 1, 1.08), gain highlights (1.06, 1, .92)).
	float luma = dot(col, vec3(0.2722, 0.6741, 0.0537));
	col = max(vec3(0.0), luma + (col - luma) * vec3(1.0, 1.0, 1.05) * 1.05);
	col = pow(max(col, vec3(0.0)) / 0.18, vec3(1.08)) * 0.18;
	luma = dot(col, vec3(0.2722, 0.6741, 0.0537));
	float wS = 1.0 - smoothstep(0.0, 0.09, luma);
	float wH = smoothstep(0.5, 1.0, luma);
	vec3 shadowG = pow(max(col, vec3(0.0)), 1.0 / vec3(0.92, 1.0, 1.08));
	col = mix(col, shadowG, wS);
	col = mix(col, col * vec3(1.06, 1.0, 0.92), wH);
	// Vignette.
	float v = 1.0 - vignette * 0.75 * smoothstep(0.25, 1.15, length(d * vec2(res.x / res.y, 1.0)) * 1.25);
	col *= v;
	col = aces(col);
	col = srgb(col);
	// Film grain.
	float n = hash(vUv * res + fract(time * 7.13) * 91.7) - 0.5;
	col += n * grain * 0.06;
	col *= 1.0 - fade;
	gl_FragColor = vec4(col, 1.0);
}`, {
			tColor: { value: null }, tBloom: { value: null }, exposure: { value: 1 }, bloomI: { value: 0.9 }, fringe: { value: 0.35 },
			vignette: { value: 0.55 }, grain: { value: 0.12 }, time: { value: 0 }, res: { value: new THREE.Vector2(1, 1) }, hasBloom: { value: 1 },
			dof: { value: 0 }, fade: { value: 0 },
		});
	}

	setQuality(q, opts) {
		this.quality = q;
		this.opts = opts;
		this.gl.shadowMap.enabled = opts.shadows;
		this.needsResize = true;
	}

	resize(scaleSetting) {
		const dpr = window.devicePixelRatio || 1;
		const cw = Math.max(1, window.innerWidth), ch = Math.max(1, window.innerHeight);
		let scale;
		if (scaleSetting > 0) scale = scaleSetting / 100 * dpr;
		else scale = Math.min(dpr, this.quality.lines / ch);
		scale = Math.max(0.35, scale);
		const w = Math.round(cw * scale), h = Math.round(ch * scale);
		if (w === this.w && h === this.h && !this.needsResize) return;
		this.needsResize = false;
		this.w = w; this.h = h; this.scale = scale;
		this.gl.setPixelRatio(1);
		this.gl.setSize(w, h, false);
		this.canvas.style.width = cw + 'px';
		this.canvas.style.height = ch + 'px';
		const dispose = (rt) => rt && rt.dispose();
		dispose(this.sceneRT); dispose(this.haloRT); dispose(this.reflRT);
		(this.bloomRTs || []).forEach(dispose);
		const hf = THREE.HalfFloatType;
		this.sceneRT = new THREE.WebGLRenderTarget(w, h, { type: hf, samples: this.quality.msaa, depthBuffer: true, depthTexture: new THREE.DepthTexture(w, h, THREE.UnsignedIntType) });
		this.haloRT = new THREE.WebGLRenderTarget(w, h, { type: hf, depthBuffer: false });
		const rw = Math.max(64, Math.round(w / 2)), rh = Math.max(64, Math.round(h / 2));
		this.reflRT = new THREE.WebGLRenderTarget(rw, rh, { type: hf, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, samples: 0 });
		this.bloomRTs = [];
		let bw = w, bh = h;
		for (let i = 0; i < 6; i++) {
			bw = Math.max(2, Math.round(bw / 2)); bh = Math.max(2, Math.round(bh / 2));
			this.bloomRTs.push(new THREE.WebGLRenderTarget(bw, bh, { type: hf, depthBuffer: false }));
			this.bloomRTs.push(new THREE.WebGLRenderTarget(bw, bh, { type: hf, depthBuffer: false }));
		}
	}

	/** UE camera (location in metres, rotator in degrees, horizontal FOV) -> three camera. */
	setCamera(loc, rot, hfovDeg) {
		const c = this.camera;
		c.aspect = this.w / this.h;
		const vfov = 2 * Math.atan(Math.tan(hfovDeg * Math.PI / 360) / c.aspect) * 180 / Math.PI;
		c.fov = Math.min(vfov, 100);
		c.updateProjectionMatrix();
		c.position.set(loc.x, loc.z, loc.y);
		// UE basis: X forward, Y right, Z up -> three camera basis x = right, y = up, z = -forward.
		const p = rot.pitch * Math.PI / 180, y = rot.yaw * Math.PI / 180, r = rot.roll * Math.PI / 180;
		const SP = Math.sin(p), CP = Math.cos(p), SY = Math.sin(y), CY = Math.cos(y), SR = Math.sin(r), CR = Math.cos(r);
		const fx = CP * CY, fy = CP * SY, fz = SP;
		const rx = SR * SP * CY - CR * SY, ry = SR * SP * SY + CR * CY, rz = -SR * CP;
		const ux = -(CR * SP * CY + SR * SY), uy = CY * SR - CR * SP * SY, uz = CR * CP;
		const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(rx, rz, ry), new THREE.Vector3(ux, uz, uy), new THREE.Vector3(-fx, -fz, -fy));
		c.quaternion.setFromRotationMatrix(m);
		c.updateMatrixWorld(true);
		shared.uPixelAngle.value = (c.fov * Math.PI / 180) / this.h;
	}

	/** Planar reflection about a plane (three space point + normal). */
	renderReflection(scene, point, normal, hide) {
		const cam = this.camera, rc = this.reflCam;
		const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
		const view = point.clone().sub(camPos);
		if (view.dot(normal) > 0) return false;
		view.reflect(normal).negate().add(point);
		const rot = new THREE.Matrix4().extractRotation(cam.matrixWorld);
		const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(camPos);
		const target = point.clone().sub(look).reflect(normal).negate().add(point);
		rc.position.copy(view);
		rc.up.set(0, 1, 0).applyMatrix4(rot).reflect(normal);
		rc.lookAt(target);
		rc.near = cam.near; rc.far = 600;
		rc.updateMatrixWorld();
		rc.projectionMatrix.copy(cam.projectionMatrix);
		rc.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
		const tm = shared.uReflMat.value;
		tm.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
		tm.multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
		// Oblique near plane so nothing below the mirror shows up.
		const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point.clone().addScaledVector(normal, -0.05));
		plane.applyMatrix4(rc.matrixWorldInverse);
		const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
		const e = rc.projectionMatrix.elements;
		const q = new THREE.Vector4((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
		clip.multiplyScalar(2 / clip.dot(q));
		e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1; e[14] = clip.w;
		shared.uReflOn.value = 0;
		shared.uReflTex.value = this.blackTex;   // never sample the target we are drawing into
		for (const o of hide) o.visible = false;
		const sm = this.gl.shadowMap.autoUpdate;
		this.gl.shadowMap.autoUpdate = false;
		this.gl.setRenderTarget(this.reflRT);
		this.gl.render(scene, rc);
		this.gl.shadowMap.autoUpdate = sm;
		for (const o of hide) o.visible = true;
		return true;
	}

	render(scene, params) {
		const gl = this.gl;
		const q = this.quality, o = this.opts;
		// 1. reflection
		let refl = false;
		if (o.refl && params.reflPlane) {
			refl = this.renderReflection(scene, params.reflPlane.point, params.reflPlane.normal, params.reflHide || []);
		}
		shared.uReflOn.value = refl ? 1 : 0;
		shared.uReflTex.value = refl ? this.reflRT.texture : this.blackTex;
		// 2. scene
		gl.setRenderTarget(this.sceneRT);
		gl.render(scene, this.camera);
		// 3. halos
		const hm = this.haloMat.uniforms;
		hm.tColor.value = this.sceneRT.texture;
		hm.tDepth.value = this.sceneRT.depthTexture;
		hm.projInv.value.copy(this.camera.projectionMatrixInverse);
		hm.viewInv.value.copy(this.camera.matrixWorld);
		hm.cameraPos.value.copy(this.camera.position);
		const hl = o.effects ? params.halos || [] : [];
		const n = Math.min(hl.length, q.halos, MAX_HALOS);
		for (let i = 0; i < n; i++) {
			const L = hl[i];
			this.halo.pos[i].copy(L.pos);
			this.halo.col[i].set(L.color.r, L.color.g, L.color.b).multiplyScalar(L.intensity * L.fog);
			this.halo.prm[i].set(L.radius, L.dir ? 1 : 0, 0);
			if (L.dir) this.halo.dir[i].copy(L.dir);
		}
		hm.hCount.value = n;
		if (params.lamp && o.effects) {
			hm.lampPos.value.copy(params.lamp.pos);
			hm.lampDir.value.copy(params.lamp.dir);
			hm.lampCol.value.set(1, 0.93, 0.82).multiplyScalar(params.lamp.intensity * 0.3);
		} else hm.lampCol.value.set(0, 0, 0);
		this.blit(this.haloMat, this.haloRT);
		// 4. bloom
		const fm = this.finalMat.uniforms;
		if (o.effects) {
			let src = this.haloRT.texture, sw = this.w, sh = this.h;
			const levels = this.bloomRTs.length / 2;
			for (let i = 0; i < levels; i++) {
				const rt = this.bloomRTs[i * 2];
				this.downMat.uniforms.tSrc.value = src;
				this.downMat.uniforms.texel.value.set(1 / sw, 1 / sh);
				this.downMat.uniforms.first.value = i === 0 ? 1 : 0;
				this.blit(this.downMat, rt);
				src = rt.texture; sw = rt.width; sh = rt.height;
			}
			// upsample: up[i] = down[i] + blur(up[i+1])
			let up = this.bloomRTs[(levels - 1) * 2].texture;
			for (let i = levels - 2; i >= 0; i--) {
				const dst = this.bloomRTs[i * 2 + 1];
				this.upMat.uniforms.tSrc.value = up;
				this.upMat.uniforms.tBase.value = this.bloomRTs[i * 2].texture;
				this.upMat.uniforms.texel.value.set(1 / dst.width, 1 / dst.height);
				this.blit(this.upMat, dst);
				up = dst.texture;
			}
			fm.tBloom.value = up;
			fm.hasBloom.value = 1;
		} else fm.hasBloom.value = 0;
		// 5. final
		fm.tColor.value = this.haloRT.texture;
		fm.exposure.value = this.exposure * Math.pow(2, this.lightningEv);
		fm.bloomI.value = params.bloom ?? 0.14;   // the chain sums 6 levels: ~0.8 effective, like Unreal's 0.9 x tints
		fm.fringe.value = this.fringe;
		fm.vignette.value = this.vignette;
		fm.time.value = this.time;
		fm.res.value.set(this.w, this.h);
		fm.fade.value = params.fade || 0;
		this.blit(this.finalMat, null);
	}

	blit(mat, target) {
		this.quad.material = mat;
		this.gl.setRenderTarget(target);
		this.gl.render(this.quadScene, this.quadCam);
	}
}
