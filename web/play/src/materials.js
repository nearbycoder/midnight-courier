// GLSL ports of the procedural Unreal materials built by MidnightCourier/Scripts/import_assets.py.
// Lit materials are MeshStandardMaterial with the procedural surface injected (base colour, roughness,
// metalness, world-space normal, emissive) plus a planar wet-ground reflection. The HLSL works in Unreal
// world space (centimetres, Z up), so the shaders convert: W = (x, z, y) * 100.
import * as THREE from 'three';

export const shared = {
	uTime: { value: 0 },
	uReflTex: { value: null },
	uReflMat: { value: new THREE.Matrix4() },
	uReflOn: { value: 0 },
	uReflStrength: { value: 1 },
	uLightning: { value: 0 },
	uCamVel: { value: new THREE.Vector3() },      // Unreal cm/s
	uLampPos: { value: new THREE.Vector3() },     // Unreal cm
	uLampDir: { value: new THREE.Vector3(1, 0, 0) },
	uPixelAngle: { value: 0.001 },                // radians per pixel (rain streak width floor)
};

export const LIB = /* glsl */`
float mc_h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float mc_n2(vec2 p) {
	vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
	return mix(mix(mc_h21(i), mc_h21(i + vec2(1.0, 0.0)), u.x), mix(mc_h21(i + vec2(0.0, 1.0)), mc_h21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float mc_fbm(vec2 p) { float a = 0.5, s = 0.0; for (int k = 0; k < 4; k++) { s += a * mc_n2(p); p = p * 2.03 + 11.7; a *= 0.5; } return s; }
vec3 mc_ripple(vec2 p, float t, float seed) {
	vec2 c = floor(p); vec2 f = fract(p) - 0.5;
	float h = mc_h21(c + seed); float h2 = mc_h21(c + seed + 17.3);
	vec2 o = (vec2(h, h2) - 0.5) * 0.45;
	float ph = fract(t * 1.25 + h * 7.1);
	vec2 d = f - o; float r = length(d); float R = ph * 0.32;
	float x = (r - R) * 38.0;
	float ring = exp(-x * x) * (1.0 - ph) * (1.0 - ph);
	vec2 n = r > 1e-4 ? d / r * ring * sin((r - R) * 70.0) : vec2(0.0);
	return vec3(n, ring);
}
vec3 mc_ripples(vec2 p, float t) {
	return mc_ripple(p * 2.3, t, 0.0) + mc_ripple(p * 2.3 + 0.5, t * 1.1 + 0.37, 5.0) + mc_ripple(p * 1.7 + 0.21, t * 0.93 + 0.71, 9.0) * 0.8;
}
float mc_puddle(vec2 p, float amount) { float n = mc_fbm(p * 0.18) * 0.7 + mc_n2(p * 0.9) * 0.3; return smoothstep(0.58 - amount, 0.66 - amount, n); }
float mc_sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 mc_srgb(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
`;

// ---- surface bodies (inputs: W, N (Unreal), C (rgb linear, a raw), U0, U1, T; outputs: base, rough, metal, nUE, emis)
const vcBody = (metal) => `
	float grain = mc_n2(W.xy * 0.05) * 0.5 + mc_n2(W.yz * 0.07) * 0.5;
	float wet = mc_sat(N.z) * 0.35;
	rough = mc_sat(C.a * (1.0 - wet) * (0.85 + 0.3 * grain));
	base = C.rgb; metal = ${metal ? '1.0' : '0.0'};
`;

const roadBody = `
	vec2 p = W.xy * 0.01;
	float pud = mc_puddle(p, 0.12) * mc_sat(N.z * 4.0 - 3.0);
	float grain = mc_n2(p * 9.0) * 0.6 + mc_n2(p * 31.0) * 0.4;
	float patchv = mc_fbm(p * 0.35);
	vec3 b = mix(vec3(0.045, 0.046, 0.05), vec3(0.07, 0.068, 0.066), patchv) * (0.8 + 0.4 * grain);
	b *= C.rgb;
	rough = mix(0.32 + 0.18 * grain, 0.02, pud);
	base = mix(b, b * 0.45, pud);
	// Fade sub-pixel detail with distance (Unreal hides it with TSR).
	float fp = length(fwidth(p));
	float fadeB = 1.0 - mc_sat(fp * 14.0 * 1.2 - 0.2);
	float fadeR = 1.0 - mc_sat(fp * 60.0 - 0.5);
	vec3 r = fadeR > 0.0 ? mc_ripples(p, T) : vec3(0.0);
	vec2 bump = (vec2(mc_n2(p * 14.0), mc_n2(p * 14.0 + 7.0)) - 0.5) * 0.18 * (1.0 - pud) * fadeB;
	vec2 s = bump + r.xy * mix(0.12, 0.5, pud) * fadeR;
	nUE = normalize(N + vec3(s, 0.0) * mc_sat(N.z));
	wetMask = mc_sat(N.z * 4.0 - 3.0);
`;

const stoneBody = (rgb, pav, rb, pa) => `
	const vec3 B = vec3(${rgb.map((v) => v.toFixed(4)).join(', ')});
	const float PAV = ${pav.toFixed(4)}; const float RB = ${rb.toFixed(4)}; const float PA = ${pa.toFixed(4)};
	vec3 q = W * 0.01;
	vec2 p = abs(N.z) > 0.6 ? q.xy : (abs(N.x) > abs(N.y) ? q.yz : q.xz);
	float grain = mc_n2(p * 7.0) * 0.5 + mc_n2(p * 23.0) * 0.5;
	float stain = mc_fbm(p * 0.6 + 3.1);
	float grout = 0.0;
	if (PAV > 0.0) { vec2 f = abs(fract(p / PAV) - 0.5); grout = smoothstep(0.47, 0.5, max(f.x, f.y)); }
	float up = mc_sat(N.z * 4.0 - 3.0);
	float pud = PA > 0.0 ? mc_puddle(q.xy * 1.3, PA) * up : 0.0;
	float streak = (1.0 - abs(N.z)) * mc_n2(vec2(p.x * 6.0, p.y * 0.4));
	vec3 b = B * C.rgb * (0.75 + 0.35 * grain) * mix(1.0, 0.7, stain * stain) * (1.0 - 0.45 * grout) * (1.0 - 0.25 * streak);
	base = mix(b, b * 0.5, pud);
	rough = mc_sat(mix(RB + 0.2 * grain + 0.25 * grout, 0.03, pud));
	float fadeR = 1.0 - mc_sat(length(fwidth(q.xy)) * 60.0 - 0.5);
	vec3 r = up > 0.0 && fadeR > 0.0 ? mc_ripples(q.xy, T) * up * fadeR : vec3(0.0);
	vec2 s = r.xy * mix(0.1, 0.45, pud);
	nUE = normalize(N + vec3(s, 0.0));
	wetMask = up;
`;

const paintBody = `
	vec2 p = W.xy * 0.01;
	float wear = mc_n2(p * 3.0) * 0.6 + mc_n2(p * 17.0) * 0.4;
	base = mix(C.rgb, vec3(0.05, 0.05, 0.055), smoothstep(0.55, 0.85, wear) * 0.8);
	rough = 0.25 + 0.2 * wear;
	wetMask = mc_sat(N.z * 4.0 - 3.0);
`;

const facadeBody = `
	vec2 U = vec2(U0.x, 1.0 - U0.y);                     // the importer flips V
	float seed = U1.x; float style = U1.y;
	float colW = mix(2.4, 3.6, fract(style * 7.31));
	float floorH = mix(3.0, 3.6, fract(style * 3.17));
	vec2 cell = vec2(floor(U.x / colW), floor((U.y - 0.6) / floorH));
	vec2 f = vec2(fract(U.x / colW), fract((U.y - 0.6) / floorH));
	float ground = step(U.y, 4.4);                       // shop level: no upper windows
	float mx = mix(0.18, 0.32, fract(style * 5.7)), my0 = 0.28, my1 = 0.12;
	vec2 wf = vec2((f.x - mx) / (1.0 - 2.0 * mx), (f.y - my0) / (1.0 - my0 - my1));
	float inWin = step(0.0, wf.x) * step(wf.x, 1.0) * step(0.0, wf.y) * step(wf.y, 1.0) * (1.0 - ground);
	float frame = inWin * (1.0 - step(0.05, wf.x) * step(wf.x, 0.95) * step(0.06, wf.y) * step(wf.y, 0.94));
	float sill = (1.0 - ground) * step(abs(f.y - my0 + 0.03), 0.03) * step(mx - 0.03, f.x) * step(f.x, 1.0 - mx + 0.03);
	float hc = mc_h21(cell + seed * 113.0);
	float on = step(1.0 - 0.34, hc) * inWin * (1.0 - frame);
	float sid = floor(fract(style * 2.71) * 4.0);
	vec3 wall = sid < 1.0 ? vec3(0.24, 0.1, 0.07) : sid < 2.0 ? vec3(0.42, 0.38, 0.33) : sid < 3.0 ? vec3(0.2, 0.2, 0.21) : vec3(0.12, 0.2, 0.2);
	wall *= mix(0.7, 1.15, mc_h21(vec2(seed, 3.3)));
	vec2 wpos = U;
	float grime = mc_n2(vec2(wpos.x * 2.0, wpos.y * 0.15)) * 0.5 + mc_n2(wpos * 0.4) * 0.5;
	float brick = 0.0;
	if (sid < 1.0) { vec2 bp = vec2(wpos.x / 0.25 + floor(wpos.y / 0.075) * 0.5, wpos.y / 0.075); vec2 bf = abs(fract(bp) - 0.5); brick = smoothstep(0.42, 0.5, max(bf.x * 0.5 + 0.25, bf.y)); }
	// Far away the brick courses and window frames are sub-pixel: fade them out instead of shimmering.
	vec2 fw = fwidth(U);
	float far = mc_sat(max(fw.x, fw.y) * 6.0 - 0.5);
	brick *= 1.0 - mc_sat(max(fw.x, fw.y) * 14.0 - 0.6);
	vec3 b = wall * (0.75 + 0.4 * grime) * (1.0 - 0.35 * brick) * mix(0.65, 1.0, mc_sat(wpos.y / 6.0));
	rough = 0.55 + 0.25 * grime;
	b = mix(b, vec3(0.02, 0.022, 0.026), inWin);
	rough = mix(rough, 0.05, inWin * (1.0 - frame));
	float fs = mc_sat(frame + sill) * (1.0 - far * 0.7);
	b = mix(b, vec3(0.45, 0.43, 0.4), fs);
	rough = mix(rough, 0.4, fs);
	base = b;
	vec3 warm = vec3(1.0, 0.62, 0.32), cool = vec3(0.55, 0.7, 1.0), tv = vec3(0.35, 0.45, 1.0);
	float hk = mc_h21(cell * 1.7 + seed * 31.0);
	vec3 c = hk < 0.62 ? warm : (hk < 0.88 ? cool : tv);
	float flick = hk > 0.88 ? (0.6 + 0.4 * mc_n2(vec2(T * 6.0, hc * 50.0))) : 1.0;
	float blinds = mc_h21(cell + 7.7) < 0.35 ? (0.55 + 0.45 * step(0.5, fract(wf.y * 9.0))) : 1.0;
	blinds = mix(blinds, 0.8, far);
	float curtain = mc_h21(cell + 3.1) < 0.3 ? smoothstep(0.25, 0.45, abs(wf.x - 0.5) * 2.0) * 0.8 + 0.2 : 1.0;
	vec2 hd = (wf - vec2(0.5, 0.75)) * vec2(1.2, 2.0);
	float hot = 0.6 + 0.8 * exp(-dot(hd, hd) * 2.5);
	float level = mix(0.6, 1.6, mc_h21(cell * 3.3 + seed));
	emis = c * on * blinds * curtain * hot * level * 3.2 * flick;
`;

const shopBody = `
	vec2 p = vec2(U0.x, 1.0 - U0.y);
	float seed = U1.x;
	float shelves = 0.75 + 0.25 * step(0.5, fract(p.y * 2.2 + seed));
	float items = 0.7 + 0.3 * mc_n2(vec2(p.x * 6.0, floor(p.y * 2.2) * 3.0 + seed * 9.0));
	float vign = mc_sat(1.2 - abs(p.y - 1.2) * 0.5);
	float flick = 0.92 + 0.08 * mc_n2(vec2(T * 9.0, seed * 40.0));
	emis = C.rgb * shelves * items * vign * flick * 2.4;
	base = vec3(0.01, 0.01, 0.012); rough = 0.04;
`;

const neonBody = `
	// A few signs buzz and stutter; the rest burn steady.
	float id = mc_h21(floor(W.xy * 0.004) + floor(W.z * 0.004));
	float flick = 1.0;
	if (id > 0.82) { float s = mc_n2(vec2(T * 14.0, id * 99.0)); flick = s > 0.35 ? 1.0 : 0.08; }
	emis = C.rgb * 28.0 * flick;
	base = vec3(0.05); rough = 0.2;
`;

const waterBody = `
	vec2 p = W.xy * 0.01;
	vec2 a = vec2(mc_n2(p * 0.6 + T * 0.05), mc_n2(p * 0.6 - T * 0.04 + 9.0)) - 0.5;
	vec2 b = vec2(mc_n2(p * 2.1 - T * 0.12), mc_n2(p * 2.1 + T * 0.1 + 3.0)) - 0.5;
	vec3 r = mc_ripples(p * 0.8, T);
	nUE = normalize(vec3(a * 0.35 + b * 0.18 + r.xy * 0.6, 1.0));
	base = vec3(0.004, 0.007, 0.01); rough = 0.02;
	wetMask = 1.0;
`;

/** name -> {body, col, uv, normal, refl, spec} */
const SPECS = {
	M_VC: { body: vcBody(false), col: 1 },
	M_VCMetal: { body: vcBody(true), col: 1 },
	M_Glow: { body: 'emis = C.rgb * 14.0; base = vec3(0.02); rough = 0.3;', col: 1 },
	M_Lamp: { body: 'emis = C.rgb * 40.0; base = vec3(0.0); rough = 0.2;', col: 1 },
	M_Neon: { body: neonBody, col: 1 },
	M_Shop: { body: shopBody, col: 1, uv: 1 },
	M_Road: { body: roadBody, col: 1, normal: 1, refl: 1 },
	M_Sidewalk: { body: stoneBody([0.34, 0.33, 0.31], 0.6, 0.42, 0.08), col: 1, normal: 1, refl: 1 },
	M_Curb: { body: stoneBody([0.42, 0.41, 0.4], 0, 0.35, 0), col: 1, normal: 1, refl: 1 },
	M_Stairs: { body: stoneBody([0.36, 0.34, 0.32], 0, 0.4, 0), col: 1, normal: 1, refl: 1 },
	M_Concrete: { body: stoneBody([0.3, 0.3, 0.3], 0, 0.5, 0.04), col: 1, normal: 1, refl: 1 },
	M_Cobble: { body: stoneBody([0.28, 0.26, 0.25], 0.22, 0.35, 0.15), col: 1, normal: 1, refl: 1 },
	M_Wood: { body: stoneBody([0.32, 0.2, 0.12], 0, 0.55, 0), col: 1, normal: 1, refl: 1 },
	M_FacadePlain: { body: stoneBody([0.28, 0.26, 0.25], 0, 0.65, 0), col: 1, normal: 1 },
	M_Roof: { body: stoneBody([0.07, 0.068, 0.065], 0, 0.7, 0), col: 1, normal: 1, refl: 1 },
	M_Paint: { body: paintBody, col: 1, refl: 1 },
	M_Facade: { body: facadeBody, uv: 1 },
	M_Water: { body: waterBody, normal: 1, refl: 1, spec: 0.6 },
};

const cache = new Map();

/** Lit procedural material by Unreal slot name. Variants: skinned (rider), ghost-free. */
export function litMaterial(name) {
	const key = SPECS[name] ? name : 'M_VC';
	if (cache.has(key)) return cache.get(key);
	const S = SPECS[key];
	const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0, fog: true });
	m.name = key;
	m.defines = {};
	if (S.col) m.defines.MC_COL = '';
	if (S.uv) m.defines.MC_UV = '';
	if (S.normal) m.defines.MC_NORMAL = '';
	if (S.refl) m.defines.MC_REFL = '';
	m.userData.mc = S;
	m.onBeforeCompile = (sh) => {
		Object.assign(sh.uniforms, shared);
		sh.vertexShader = sh.vertexShader
			.replace('#include <common>', `#include <common>
varying vec3 vMcW; varying vec3 vMcN;
#ifdef MC_COL
attribute vec4 aCol; varying vec4 vMcC;
#endif
#ifdef MC_UV
attribute vec2 aUv0; attribute vec2 aUv1; varying vec2 vMcU0; varying vec2 vMcU1;
#endif
vec3 mc_srgbv(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
`)
			.replace('#include <fog_vertex>', `#include <fog_vertex>
	{
		vec4 mcw = vec4(transformed, 1.0);
		#ifdef USE_INSTANCING
			mcw = instanceMatrix * mcw;
		#endif
		vMcW = (modelMatrix * mcw).xyz;
		vMcN = normalize(mat3(modelMatrix) * objectNormal);
	#ifdef MC_COL
		vMcC = vec4(mc_srgbv(aCol.rgb), aCol.a);
	#endif
	#ifdef MC_UV
		vMcU0 = aUv0; vMcU1 = aUv1;
	#endif
	}`);
		sh.fragmentShader = sh.fragmentShader
			.replace('#include <common>', `#include <common>
uniform float uTime; uniform sampler2D uReflTex; uniform mat4 uReflMat; uniform float uReflOn; uniform float uReflStrength;
varying vec3 vMcW; varying vec3 vMcN;
#ifdef MC_COL
varying vec4 vMcC;
#endif
#ifdef MC_UV
varying vec2 vMcU0; varying vec2 vMcU1;
#endif
${LIB}
void mcSurface(out vec3 base, out float rough, out float metal, out vec3 nUE, out vec3 emis, out float wetMask) {
	vec3 W = vec3(vMcW.x, vMcW.z, vMcW.y) * 100.0;
	vec3 N = normalize(vec3(vMcN.x, vMcN.z, vMcN.y));
	if (!gl_FrontFacing) N = -N;
	float T = uTime;
#ifdef MC_COL
	vec4 C = vMcC;
#else
	vec4 C = vec4(1.0);
#endif
#ifdef MC_UV
	vec2 U0 = vMcU0, U1 = vMcU1;
#else
	vec2 U0 = vec2(0.0), U1 = vec2(0.0);
#endif
	base = vec3(0.5); rough = 0.5; metal = 0.0; nUE = N; emis = vec3(0.0); wetMask = 0.0;
	${S.body}
}
`)
			.replace('#include <color_fragment>', `
	vec3 mcBase; float mcRough; float mcMetal; vec3 mcN; vec3 mcEmis; float mcWet;
	mcSurface(mcBase, mcRough, mcMetal, mcN, mcEmis, mcWet);
	diffuseColor.rgb = mcBase;
`)
			.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mcRough;')
			.replace('#include <metalnessmap_fragment>', 'float metalnessFactor = mcMetal;')
			.replace('#include <normal_fragment_maps>', `
#ifdef MC_NORMAL
	normal = normalize((viewMatrix * vec4(mcN.x, mcN.z, mcN.y, 0.0)).xyz);
#endif
`)
			.replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = mcEmis;')
			.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
#ifdef MC_REFL
	if (uReflOn > 0.5 && mcWet > 0.0) {
		vec3 nw = vec3(mcN.x, mcN.z, mcN.y);
		vec4 rc = uReflMat * vec4(vMcW, 1.0);
		vec2 ruv = rc.xy / rc.w + nw.xz * 0.06;
		float lod = clamp(material.roughness * 9.0, 0.0, 6.0);
		vec3 rcol = textureLod(uReflTex, ruv, lod).rgb;
		float edge = mc_sat(min(min(ruv.x, 1.0 - ruv.x), min(ruv.y, 1.0 - ruv.y)) * 12.0);
		reflectedLight.indirectSpecular += rcol * edge * mcWet * uReflStrength * EnvironmentBRDF(geometryNormal, geometryViewDir, material.specularColorBlended, material.specularF90, material.roughness);
	}
#endif
`);
		if (S.spec) {
			sh.fragmentShader = sh.fragmentShader.replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
	material.specularColor = vec3(0.08 * ${S.spec.toFixed(2)});
	material.specularColorBlended = mix(material.specularColor, diffuseColor.rgb, metalnessFactor);`);
		}
	};
	m.customProgramCacheKey = () => 'mc_' + key;
	cache.set(key, m);
	return m;
}

// ==========================================================================================================
// Unlit / special
// ==========================================================================================================

export function rainMaterial() {
	return new THREE.ShaderMaterial({
		name: 'M_Rain',
		uniforms: { uTime: shared.uTime, uCamVel: shared.uCamVel, uLampPos: shared.uLampPos, uLampDir: shared.uLampDir, uPixelAngle: shared.uPixelAngle, uBright: { value: 0.11 } },
		vertexShader: /* glsl */`
attribute vec4 aCol; attribute vec2 aUv0;
uniform float uTime; uniform vec3 uCamVel; uniform float uPixelAngle;
varying vec3 vW; varying vec2 vUV; varying vec4 vC; varying float vWidthGain;
vec3 mc_srgbv(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
void main() {
	vec2 UV = aUv0; UV.y = 1.0 - UV.y;
	vec4 C = vec4(mc_srgbv(aCol.rgb), aCol.a);
	vec3 P = vec3(position.x, position.z, position.y) * 100.0;    // Unreal local cm
	vec3 Cam = vec3(cameraPosition.x, cameraPosition.z, cameraPosition.y) * 100.0;
	vec3 RV = vec3(180.0, 90.0, -1100.0);
	vec3 anchor = P - vec3(UV.x * 4.0, 0.0, UV.y * 8.0);
	vec3 box = vec3(3400.0, 3400.0, 1800.0);
	float speed = 0.85 + 0.3 * C.g;
	vec3 p = anchor + RV * uTime * speed;
	vec3 rel = p - Cam;
	rel = (fract(rel / box + 0.5) - 0.5) * box;
	vec3 a = Cam + rel;
	vec3 v = RV * speed - uCamVel * 0.85;
	vec3 dir = normalize(v);
	vec3 toCam = normalize(Cam - a);
	vec3 side = normalize(cross(dir, toCam));
	float len = clamp(length(v) * 0.045, 35.0, 140.0) * (0.7 + 0.6 * C.r);
	// Streaks are 0.9 cm wide; without temporal AA keep them at least ~0.8 px wide and dim them to match.
	float minW = length(Cam - a) * uPixelAngle * 0.8;
	float w = max(0.9, minW);
	vWidthGain = 0.9 / w;
	vec3 vtx = a + dir * (UV.y - 0.5) * len + side * UV.x * w;
	vW = vtx; vUV = UV; vC = C;
	gl_Position = projectionMatrix * viewMatrix * vec4(vtx.x * 0.01, vtx.z * 0.01, vtx.y * 0.01, 1.0);
}`,
		fragmentShader: /* glsl */`
uniform vec3 uLampPos; uniform vec3 uLampDir; uniform float uBright;
varying vec3 vW; varying vec2 vUV; varying vec4 vC; varying float vWidthGain;
void main() {
	vec3 Cam = vec3(cameraPosition.x, cameraPosition.z, cameraPosition.y) * 100.0;
	float d = length(vW - Cam);
	float fade = smoothstep(60.0, 260.0, d) * (1.0 - smoothstep(1100.0, 1700.0, d));
	float edge = 1.0 - abs(vUV.x * 2.0);
	vec3 toP = vW - uLampPos; float dl = length(toP);
	float cone = smoothstep(0.86, 0.97, dot(toP / max(dl, 1.0), normalize(uLampDir))) * clamp(1.0 - dl / 2600.0, 0.0, 1.0);
	vec3 c = vec3(0.65, 0.75, 0.9) * uBright + vec3(1.0, 0.95, 0.85) * cone * 1.6;
	gl_FragColor = vec4(c * fade * edge * (0.6 + 0.4 * vC.b) * vWidthGain, 1.0);
}`,
		blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide, fog: false,
	});
}

export function beaconMaterial() {
	return new THREE.ShaderMaterial({
		name: 'M_Beacon',
		uniforms: { uTime: shared.uTime, uColor: { value: new THREE.Color(1.0, 0.55, 0.12) } },
		vertexShader: /* glsl */`
attribute vec2 aUv0; varying vec2 vUV; varying vec3 vN; varying vec3 vW;
void main() { vUV = aUv0; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
		fragmentShader: /* glsl */`
uniform float uTime; uniform vec3 uColor; varying vec2 vUV; varying vec3 vN; varying vec3 vW;
void main() {
	float v = 1.0 - vUV.y;
	vec3 V = normalize(cameraPosition - vW);
	float soft = pow(clamp(abs(dot(normalize(vN), V)), 0.0, 1.0), 1.6);
	float pulse = 0.75 + 0.25 * sin(uTime * 2.4);
	float rise = 0.85 + 0.15 * sin(v * 60.0 - uTime * 4.0);
	float ring = v < 0.03 ? 2.5 : 1.0;
	gl_FragColor = vec4(uColor * pow(1.0 - v, 1.4) * soft * pulse * rise * ring * 1.4, 1.0);
}`,
		blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide, fog: false,
	});
}

export function skyMaterial() {
	return new THREE.ShaderMaterial({
		name: 'M_Sky',
		uniforms: { uTime: shared.uTime, uLightning: shared.uLightning },
		vertexShader: /* glsl */`
varying vec3 vDir;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vDir = w.xyz - cameraPosition; gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w * 0.99999; }`,
		fragmentShader: /* glsl */`
uniform float uTime; uniform float uLightning; varying vec3 vDir;
${LIB}
void main() {
	vec3 d = normalize(vec3(vDir.x, vDir.z, vDir.y));
	float h = d.z; float T = uTime; float F = uLightning;
	vec3 zenith = vec3(0.004, 0.006, 0.014);
	vec3 horizon = vec3(0.07, 0.04, 0.05);
	vec3 glow = vec3(0.16, 0.07, 0.035);
	vec3 c = mix(horizon, zenith, mc_sat(pow(max(h, 0.0), 0.55)));
	c += glow * exp(-max(h, 0.0) * 9.0);
	vec2 p = d.xy / max(h + 0.12, 0.05) * 1.3 + vec2(T * 0.006, T * 0.002);
	float cl = mc_fbm(p) * 0.65 + mc_fbm(p * 2.7 + 4.0) * 0.35;
	float cloud = smoothstep(0.35, 0.8, cl);
	vec3 lit = vec3(0.08, 0.05, 0.05) * exp(-max(h, 0.0) * 3.0) + vec3(0.5, 0.55, 0.7) * F * 1.5;
	c = mix(c, c * 0.5 + lit * (0.4 + 0.6 * cl), cloud * mc_sat(h * 6.0 + 0.3));
	gl_FragColor = vec4(c * (1.0 + F * 3.0), 1.0);
}`,
		side: THREE.BackSide, depthWrite: false, fog: false,
	});
}

/** Additive fresnel scan-line ghost (M_Ghost); works for static and skinned meshes. */
export function ghostMaterial() {
	return new THREE.ShaderMaterial({
		name: 'M_Ghost',
		uniforms: { uTime: shared.uTime, uColor: { value: new THREE.Color(0.15, 0.9, 1.0) } },
		vertexShader: /* glsl */`
#include <common>
#include <skinning_pars_vertex>
varying vec3 vN; varying vec3 vW;
void main() {
	#include <beginnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <begin_vertex>
	#include <skinning_vertex>
	vec4 w = modelMatrix * vec4(transformed, 1.0);
	vW = w.xyz; vN = normalize(mat3(modelMatrix) * objectNormal);
	gl_Position = projectionMatrix * viewMatrix * w;
}`,
		fragmentShader: /* glsl */`
uniform float uTime; uniform vec3 uColor; varying vec3 vN; varying vec3 vW;
void main() {
	vec3 V = normalize(cameraPosition - vW);
	vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
	float F = pow(1.0 - max(0.0, dot(N, V)), 2.5) * 0.95 + 0.05;
	float scan = 0.7 + 0.3 * sin(vW.y * 100.0 * 0.25 - uTime * 6.0);
	gl_FragColor = vec4(uColor * (0.05 + F * 0.9) * scan * 1.6, 1.0);
}`,
		blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
	});
}

/** Wheel spray puffs (M_Spray) as soft points. */
export function sprayMaterial() {
	return new THREE.ShaderMaterial({
		name: 'M_Spray',
		uniforms: { uScale: { value: 1000 } },
		vertexShader: /* glsl */`
attribute float aSize; attribute float aOpacity; uniform float uScale; varying float vO;
void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = aSize * uScale / max(-mv.z, 0.1); vO = aOpacity; gl_Position = projectionMatrix * mv; }`,
		fragmentShader: /* glsl */`
varying float vO;
void main() { vec2 d = gl_PointCoord - 0.5; float a = clamp(1.0 - length(d) * 2.0, 0.0, 1.0) * vO; if (a <= 0.001) discard; gl_FragColor = vec4(vec3(0.12, 0.13, 0.15) * a, a); }`,
		blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
		depthWrite: false, transparent: true, fog: false,
	});
}
